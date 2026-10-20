const { makeHarness, reporter } = require('./harness.cjs');
const { check, done } = reporter();

// Production state as it exists today: months, goals, pots, no `rules` key.
const legacy = {
  settings: { monthlyBudget: 3000, carryDeficit: true },
  months: { '2026-10': { budget: 3000, stashed: 250, txns: [
    { id: 'd1', date: '2026-10-05', name: 'Hotel Bar', amount: 420, by: 'card', src: 'card', at: 1 },
    { id: 'd2', date: '2026-10-07', name: 'Ramen', amount: 180, by: 'Me', src: 'manual', at: 2 }
  ] } },
  goals: [{ id: 'g1', label: 'Weekend away', amount: 2500 }],
  lastSnapshot: '2026-10-07',
  pots: {
    holiday: { rates: [{ from: '2026-01', monthly: 2000 }], entries: [{ id: 'h1', date: '2026-04-02', name: 'Flights', amount: 4200, by: 'Me', at: 3 }] }
  }
};

(async () => {
  const h = await makeHarness(legacy);

  console.log('--- migration: legacy state loads and gains the new fields ---');
  let r = await h.app('/api/state');
  check('loads', r.status === 200);
  check('rules default to empty', Array.isArray(r.json.rules) && r.json.rules.length === 0);
  check('categories exposed for the UI', r.json.cats.map(c => c.key).join() === 'dining,holiday,clothing');
  check('existing dining entries survive', r.json.current.txns.length === 2);
  check('existing pot survives', r.json.pots.holiday.entries.length === 1);
  check('entries carry the unified shape',
    r.json.current.txns.every(t => 'src' in t && 'pending' in t && 'foreign' in t));
  const hb = r.json.current.txns.find(t => t.id === 'd1');
  check('legacy card entry reports src=card', hb.src === 'card' && hb.pending === false && hb.foreign === null);

  console.log('\n--- move: dining -> holiday (the hotel bar was a holiday spend) ---');
  const spentBefore = r.json.current.spent;
  r = await h.app('/api/alloc/move', { from: 'dining', id: 'd1', to: 'holiday' });
  check('move succeeds', r.status === 200, 'status=' + r.status);
  check('gone from dining', !r.json.current.txns.some(t => t.id === 'd1'));
  check('dining spend drops by exactly that amount', r.json.current.spent === spentBefore - 420, 'spent=' + r.json.current.spent);
  const moved = r.json.pots.holiday.entries.find(e => e.id === 'd1');
  check('arrived in holiday intact', moved && moved.amount === 420 && moved.name === 'Hotel Bar' && moved.src === 'card');
  check('holiday spent rises by exactly that amount', r.json.pots.holiday.spent === 4200 + 420);
  check('same id kept', !!moved);
  check('entry exists in exactly one place', (JSON.stringify(h.stored()).match(/"id":"d1"/g) || []).length === 1);

  console.log('\n--- move: holiday -> dining lands in the entry\'s own month ---');
  r = await h.app('/api/alloc/move', { from: 'holiday', id: 'h1', to: 'dining' });
  const st = h.stored();
  check('April flight filed under April, not this month', st.months['2026-04'] && st.months['2026-04'].txns.some(t => t.id === 'h1'));
  check('this month untouched by that move', !st.months['2026-10'].txns.some(t => t.id === 'h1'));

  console.log('\n--- move: clothing <-> holiday and manual entries ---');
  await h.app('/api/pot/entry', { pot: 'clothing', name: 'Boots', amount: 1200 });
  const boots = (await h.app('/api/state')).json.pots.clothing.entries[0];
  r = await h.app('/api/alloc/move', { from: 'clothing', id: boots.id, to: 'holiday' });
  check('manual entry moves too', r.json.pots.holiday.entries.some(e => e.id === boots.id && e.src === 'manual'));
  check('clothing emptied', r.json.pots.clothing.entries.length === 0);

  console.log('\n--- move: validation ---');
  r = await h.app('/api/alloc/move', { from: 'dining', id: 'd2', to: 'dining' });
  check('same category rejected', r.status === 400);
  r = await h.app('/api/alloc/move', { from: 'dining', id: 'd2', to: 'nonsense' });
  check('unknown target rejected', r.status === 400);
  r = await h.app('/api/alloc/move', { from: 'nonsense', id: 'd2', to: 'holiday' });
  check('unknown source rejected', r.status === 400);
  r = await h.app('/api/alloc/move', { from: 'holiday', id: 'd2', to: 'clothing' });
  check('entry looked up in the stated ledger only', r.status === 404);
  r = await h.app('/api/alloc/move', { from: 'dining', id: 'x'.repeat(100), to: 'holiday' });
  check('oversized id rejected', r.status === 400);
  r = await h.app('/api/alloc/move', { from: 'dining', id: 123, to: 'holiday' });
  check('non-string id rejected', r.status === 400);

  console.log('\n--- move into a full ledger loses nothing ---');
  const full = await makeHarness({
    settings: { monthlyBudget: 3000, carryDeficit: true }, goals: [], lastSnapshot: null,
    months: { '2026-10': { budget: 3000, stashed: 0, txns: [{ id: 'keep', date: '2026-10-01', name: 'Keep me', amount: 50, by: 'Me', src: 'manual', at: 1 }] } },
    pots: { holiday: { rates: [{ from: '2026-01', monthly: 2000 }],
      entries: Array.from({ length: 500 }, (_, i) => ({ id: 'e' + i, date: '2026-01-01', name: 'x', amount: 1, by: 'Me', at: i })) } }
  });
  r = await full.app('/api/alloc/move', { from: 'dining', id: 'keep', to: 'holiday' });
  check('refused with 409', r.status === 409, 'status=' + r.status);
  check('entry still in dining, not lost', full.stored().months['2026-10'].txns.some(t => t.id === 'keep'));
  check('holiday not over its cap', full.stored().pots.holiday.entries.length === 500);
  r = await full.card({ v: 2, mcc: '4511', name: 'One Too Many', amount: 10, currency: 'zar' });
  check('card spend into a full pot is refused cleanly', r.status === 409, 'status=' + r.status);

  console.log('\n--- merchant rules ---');
  r = await h.app('/api/rule', { match: 'Hotel Bar & Grill', category: 'holiday' });
  check('rule added', r.status === 200 && r.json.rules.length === 1);
  check('stored normalised', r.json.rules[0].match === 'hotel bar grill' && r.json.rules[0].category === 'holiday', JSON.stringify(r.json.rules));
  r = await h.app('/api/rule', { match: 'hotel bar grill', category: 'dining' });
  check('same fragment updates rather than duplicates', r.json.rules.length === 1 && r.json.rules[0].category === 'dining');
  r = await h.app('/api/rule', { match: 'hotel bar grill', category: '' });
  check('empty category removes the rule', r.json.rules.length === 0);
  r = await h.app('/api/rule', { match: 'hotel bar grill', category: null });
  check('removing a missing rule is harmless', r.status === 200);
  r = await h.app('/api/rule', { match: 'ab', category: 'holiday' });
  check('too-short fragment rejected', r.status === 400);
  r = await h.app('/api/rule', { match: 'x'.repeat(31), category: 'holiday' });
  check('too-long fragment rejected', r.status === 400);
  r = await h.app('/api/rule', { match: '!!!***', category: 'holiday' });
  check('fragment with no letters or digits rejected', r.status === 400);
  r = await h.app('/api/rule', { match: 'spur', category: 'bogus' });
  check('unknown category rejected', r.status === 400);
  r = await h.app('/api/rule', { match: 'constructor', category: 'holiday' });
  check('prototype-ish names are stored as plain keys', r.status === 200 && r.json.rules[0].match === 'constructor');
  await h.app('/api/rule', { match: 'constructor', category: '' });
  r = await h.app('/api/rule', { match: '__proto__', category: 'holiday' });
  check('__proto__ cannot pollute', r.status === 200 && ({}).proto === undefined && Object.prototype.hasOwnProperty.call(h.stored().rules, 'proto'));
  await h.app('/api/rule', { match: 'proto', category: '' });

  for (let i = 0; i < 50; i++) await h.app('/api/rule', { match: 'merchant' + String(i).padStart(3, '0'), category: 'clothing' });
  r = await h.app('/api/rule', { match: 'onetoomany', category: 'clothing' });
  check('rule count is capped', r.status === 409, 'status=' + r.status);
  r = await h.app('/api/rule', { match: 'merchant007', category: 'holiday' });
  check('an existing rule can still be edited at the cap', r.status === 200);

  console.log('\n--- unauthenticated callers cannot touch any of it ---');
  for (const [path, body] of [['/api/alloc/move', { from: 'dining', id: 'd2', to: 'holiday' }],
                              ['/api/alloc/settle', { ledger: 'holiday', id: 'a', amount: 5 }],
                              ['/api/rule', { match: 'woolworths', category: 'clothing' }]]) {
    const res = await h.worker.fetch(new Request('https://x.dev' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), h.env);
    check(path + ' without Access identity -> 401', res.status === 401, 'status=' + res.status);
  }
  const viaCardKey = await h.worker.fetch(new Request('https://x.dev/api/rule', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-card-key': h.CARD_KEY }, body: JSON.stringify({ match: 'woolworths', category: 'clothing' }) }), h.env);
  check('the card key does not unlock the app routes', viaCardKey.status === 401, 'status=' + viaCardKey.status);

  console.log('\n--- a corrupt pot cannot take the card path or the state view down ---');
  const bad = await makeHarness({ settings: { monthlyBudget: 3000, carryDeficit: true }, months: {}, goals: [], lastSnapshot: null, pots: { holiday: 'garbage', clothing: { rates: 5, entries: 'no' } }, rules: 'nope' });
  r = await bad.app('/api/state');
  check('state still renders with corrupt pots/rules', r.status === 200 && Array.isArray(r.json.rules), 'status=' + r.status);
  r = await bad.card({ v: 2, mcc: '5812', name: 'Spur', amount: 200, currency: 'zar' });
  check('dining card spend still lands', r.status === 200 && r.json.category === 'dining', JSON.stringify(r.json));
  r = await bad.card({ v: 2, mcc: '4511', name: 'Airline', amount: 200, currency: 'zar' });
  check('card spend into a corrupt pot returns a clean error, not a crash', r.status === 200 || r.status === 500, 'status=' + r.status);

  done('move / rules / migration tests passed');
})();
