const fs = require('fs');
const { makeHarness, reporter, WORKER_PATH } = require('./harness.cjs');
const { check, done } = reporter();

/* ---------- classify(): pure logic, lifted out of the worker source ---------- */
let src = fs.readFileSync(WORKER_PATH, 'utf8').split('/* ---------- responses ---------- */')[0];
const M = new Function('crypto', src + '\nreturn { classify, normName, CATEGORIES, MCC_RANGES };')(globalThis.crypto);

(async () => {
  console.log('--- merchant code -> category ---');
  const cat = (mcc, name = 'x', rules = {}) => M.classify(mcc, name, rules).category;
  const cases = [
    [5812, 'dining'], [5811, 'dining'], [5813, 'dining'], [5814, 'dining'], [5462, 'dining'],
    ['5812', 'dining'],                                   // the runtime payload sends the code as a string
    [4511, 'holiday'], [7011, 'holiday'], [4722, 'holiday'], [7512, 'holiday'], [4411, 'holiday'],
    [3005, 'holiday'], [3299, 'holiday'],                 // airline range, both edges
    [3366, 'holiday'], [3351, 'holiday'], [3441, 'holiday'],   // car rental brands
    [3504, 'holiday'], [3838, 'holiday'],                 // hotel brands
    [5661, 'clothing'], [5651, 'clothing'], [5699, 'clothing'], [5697, 'clothing'], [5611, 'clothing'],
    [5411, null], [5541, null], [5311, null], [7996, null], [5999, null], [4121, null],
    [3300, null], [3442, null], [3839, null],             // just outside each range
    [undefined, null], ['', null], ['abc', null], [null, null], [58.5, null]
  ];
  for (const [mcc, want] of cases) check('mcc ' + JSON.stringify(mcc) + ' -> ' + want, cat(mcc) === want);

  console.log('\n--- merchant rules beat the code table ---');
  check('rule overrides a dining code', cat(5812, 'Hotel Bar & Grill', { 'hotel bar': 'holiday' }) === 'holiday');
  check('rule claims an otherwise untracked code', cat(5311, 'WOOLWORTHS CAPE TOWN', { woolworths: 'clothing' }) === 'clothing');
  check('rule matches punctuation-mangled names', cat(5311, 'SQ *Woolworths-Canal Walk', { woolworths: 'clothing' }) === 'clothing');
  check('longest fragment wins', cat(5311, 'Woolworths Food Court', { woolworths: 'clothing', 'woolworths food': 'dining' }) === 'dining');
  check('non-matching rule is ignored', cat(5812, 'Spur', { woolworths: 'clothing' }) === 'dining');
  check('rule with a bogus category is ignored', cat(5812, 'Spur', { spur: 'nonsense' }) === 'dining');
  check('null rules tolerated', M.classify(5812, 'x', null).category === 'dining');
  check('corrupt rules (string) tolerated', M.classify(5812, 'x', 'oops').category === 'dining');

  console.log('\n--- routing card spend through the real router ---');
  const h = await makeHarness();
  const send = (o) => h.card(Object.assign({ v: 2, currency: 'zar', by: 'Me' }, o));

  let r = await send({ mcc: '5812', name: 'Kloof Street House', amount: 260 });
  check('restaurant -> dining', r.json.category === 'dining' && r.json.via === 'mcc', JSON.stringify(r.json));

  r = await send({ mcc: '4511', name: 'FlySafair', amount: 2400 });
  check('airline -> holiday', r.json.category === 'holiday', JSON.stringify(r.json));
  check('holiday reports its balance', typeof r.json.remaining === 'number');

  r = await send({ mcc: '5661', name: 'Total Sports', amount: 1800 });
  check('shoe store -> clothing', r.json.category === 'clothing');

  r = await send({ mcc: '5411', name: 'Checkers', amount: 900 });
  check('groceries are ignored', r.json.ignored === true && r.status === 200, JSON.stringify(r.json));

  let st = h.stored();
  const all = [...Object.values(st.months).flatMap(m => m.txns), ...st.pots.holiday.entries, ...st.pots.clothing.entries];
  check('ignored spend was not stored', !all.some(t => t.name === 'Checkers'));
  check('dining landed in months', Object.values(st.months).some(m => m.txns.some(t => t.name === 'Kloof Street House')));
  check('holiday landed in its pot, tagged as card', st.pots.holiday.entries.length === 1 && st.pots.holiday.entries[0].src === 'card');
  check('clothing landed in its pot', st.pots.clothing.entries.length === 1 && st.pots.clothing.entries[0].amount === 1800);
  check('merchant code kept on the entry', st.pots.holiday.entries[0].mcc === 4511);

  console.log('\n--- a version-2 caller with no code is ignored, never filed as dining ---');
  const before = JSON.stringify(h.stored());
  r = await send({ name: 'Mystery', amount: 55 });
  check('v2 without mcc is ignored', r.json.ignored === true && /no merchant code/.test(r.json.reason), JSON.stringify(r.json));
  check('nothing was written', JSON.stringify(h.stored()) === before);

  console.log('\n--- legacy card code (no mcc, no v) still works as dining ---');
  r = await h.card({ name: 'Old Code Cafe', amount: 120, date: '2026-09-02', by: 'card' });
  check('legacy body -> dining', r.json.category === 'dining' && r.json.via === 'legacy', JSON.stringify(r.json));
  r = await h.card({ peek: true });
  check('the removed peek call books nothing and cannot be mistaken for spend', r.status === 400, 'status=' + r.status);
  check('and it did not create an entry', !JSON.stringify(h.stored()).includes('"peek"'));

  console.log('\n--- rules applied to live card spend ---');
  await h.app('/api/rule', { match: 'woolworths', category: 'clothing' });
  r = await send({ mcc: '5311', name: 'WOOLWORTHS CANAL WALK', amount: 750 });
  check('rule files a department store under clothing', r.json.category === 'clothing' && r.json.via === 'rule', JSON.stringify(r.json));

  console.log('\n--- duplicates are caught across every ledger ---');
  await send({ mcc: '4511', name: 'Airlink', amount: 3100 });
  r = await send({ mcc: '4511', name: 'Airlink', amount: 3100 });
  check('repeat within two minutes is a duplicate', r.json.duplicate === true, JSON.stringify(r.json));
  check('only one copy stored', h.stored().pots.holiday.entries.filter(e => e.name === 'Airlink').length === 1);

  const air = h.stored().pots.holiday.entries.find(e => e.name === 'Airlink');
  await h.app('/api/alloc/move', { from: 'holiday', id: air.id, to: 'clothing' });
  r = await send({ mcc: '4511', name: 'Airlink', amount: 3100 });
  check('retry after a Move is still a duplicate', r.json.duplicate === true, JSON.stringify(r.json));
  st = h.stored();
  check('the retry did not resurrect it in holiday', !st.pots.holiday.entries.some(e => e.name === 'Airlink'));
  check('it stayed where it was moved to', st.pots.clothing.entries.some(e => e.name === 'Airlink'));

  r = await send({ mcc: '4511', name: 'Airlink', amount: 3200 });
  check('a different amount is not a duplicate', !r.json.duplicate && r.json.ok === true);

  console.log('\n--- foreign currency is held, not guessed ---');
  const holBefore = (await h.app('/api/state')).json.pots.holiday;
  r = await send({ mcc: '7011', name: 'Hotel Colosseo', amount: 840.5, currency: 'eur' });
  check('foreign spend accepted as pending', r.json.ok === true && r.json.pending === true, JSON.stringify(r.json));
  let hol = (await h.app('/api/state')).json.pots.holiday;
  const pend = hol.entries.find(e => e.name === 'Hotel Colosseo');
  check('stored with the original currency', pend.foreign.currency === 'EUR' && pend.foreign.amount === 840.5);
  check('counts as R0 until settled', pend.amount === 0 && pend.pending === true);
  check('pot balance unchanged by the pending entry', hol.available === holBefore.available, hol.available + ' vs ' + holBefore.available);

  r = await send({ mcc: '7011', name: 'Hotel Colosseo', amount: 840.5, currency: 'eur' });
  check('foreign duplicate caught on the original amount', r.json.duplicate === true);

  r = await h.app('/api/alloc/settle', { ledger: 'holiday', id: pend.id, amount: 16980.25 });
  hol = r.json.pots.holiday;
  const settled = hol.entries.find(e => e.id === pend.id);
  check('settled with a rand amount', settled.amount === 16980.25 && settled.pending === false);
  check('settled entry now draws the pot down', Math.round((holBefore.available - hol.available) * 100) / 100 === 16980.25,
    'drop=' + (holBefore.available - hol.available));
  check('original currency kept for the record', settled.foreign && settled.foreign.currency === 'EUR');

  r = await h.app('/api/alloc/settle', { ledger: 'holiday', id: pend.id, amount: 5 });
  check('cannot settle the same entry twice', r.status === 404);
  r = await h.app('/api/alloc/settle', { ledger: 'holiday', id: 'nope', amount: 5 });
  check('settling an unknown entry is a 404', r.status === 404);
  r = await h.app('/api/alloc/settle', { ledger: 'holiday', id: pend.id, amount: -3 });
  check('bad rand amount rejected', r.status === 400);

  console.log('\n--- input hardening on the card endpoint ---');
  r = await send({ mcc: '5812', name: 'x', amount: 10, currency: 'eurooo' });
  check('malformed currency rejected', r.status === 400, 'status=' + r.status);
  r = await send({ mcc: '5812', name: 'x', amount: -10 });
  check('negative amount rejected', r.status === 400);
  r = await send({ mcc: '5812', name: 'x', amount: 'abc' });
  check('non-numeric amount rejected', r.status === 400);
  r = await h.card({ v: 2, mcc: '5812', name: 'x', amount: 10 }, 'wrong-key');
  check('wrong card key is refused', r.status === 401);
  r = await send({ mcc: { $gt: 1 }, name: 'x', amount: 10 });
  check('object-valued mcc cannot crash the card path', r.status === 200 && r.json.ignored === true, 'status=' + r.status);

  console.log('\n--- the card date is South African time ---');
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-31T22:30:00Z');       // 00:30 on 1 Nov in Cape Town
  r = await send({ mcc: '5812', name: 'Midnight Burger', amount: 99 });
  Date.now = realNow;
  const mb = Object.entries(h.stored().months).flatMap(([k, m]) => m.txns.map(t => ({ k, t }))).find(x => x.t.name === 'Midnight Burger');
  check('dated 1 November, not 31 October', mb.t.date === '2026-11-01', mb.t.date);
  check('filed under the November month', mb.k === '2026-11', mb.k);

  done('allocation tests passed');
})();
