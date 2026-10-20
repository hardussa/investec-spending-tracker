const { JSDOM, VirtualConsole } = require('jsdom');
const { makeHarness, reporter } = require('./harness.cjs');
const { check, done } = reporter();

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(15); }
  return false;
}

(async () => {
  const h = await makeHarness();

  // ---- seed realistic data through the real routes ----
  await h.app('/api/settings', { monthlyBudget: 3000, carryDeficit: true });
  await h.app('/api/pot/settings', { pot: 'holiday', monthly: 2000, startMonth: '2026-01' });
  await h.app('/api/pot/settings', { pot: 'clothing', monthly: 500, startMonth: '2026-01' });
  const send = o => h.card(Object.assign({ v: 2, currency: 'zar', by: 'Me' }, o));
  await send({ mcc: '5812', name: 'Kloof Street House', amount: 260 });
  await send({ mcc: '4511', name: 'FlySafair', amount: 2400 });
  await send({ mcc: '5661', name: 'Total Sports', amount: 1800 });
  await send({ mcc: '7011', name: 'Hotel Colosseo', amount: 840.5, currency: 'eur' });     // pending
  await send({ mcc: '5812', name: 'Trattoria Roma', amount: 40, currency: 'eur' });        // pending, in dining
  await h.app('/api/rule', { match: 'woolworths', category: 'clothing' });

  // ---- load the page exactly as the worker serves it ----
  const pageRes = await h.worker.fetch(new Request('https://x.dev/'), h.env);
  const html = await pageRes.text();
  check('page served', pageRes.status === 200 && html.includes('data-pot="holiday"'));

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && e.message || e)));
  vc.on('error', e => errors.push(String(e)));

  let promptAnswer = null;
  const dom = new JSDOM(html, {
    url: 'https://x.dev/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (path, opts = {}) => {
        const headers = Object.assign({}, opts.headers || {}, { 'Cf-Access-Jwt-Assertion': h.TOKEN });
        return h.worker.fetch(new Request(new URL(path, 'https://x.dev/'), { method: opts.method || 'GET', headers, body: opts.body }), h.env);
      };
      window.prompt = () => promptAnswer;
    }
  });
  const { window } = dom;
  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const $$ = s => [...doc.querySelectorAll(s)];
  window.addEventListener('error', e => errors.push(String(e.message)));

  const opened = await until(() => !$('#app').classList.contains('hide'));
  check('app opened past the sign-in gate', opened);
  check('no script errors on load', errors.length === 0, errors.join(' | '));

  console.log('\n--- every ledger renders through the one row renderer ---');
  const dRows = $$('#list .item');
  check('dining list has its rows', dRows.length === 2, 'rows=' + dRows.length);
  const hRows = $$('[data-pot="holiday"] [data-f="list"] .item');
  const cRows = $$('[data-pot="clothing"] [data-f="list"] .item');
  check('holiday list has 2 rows (flight + pending hotel)', hRows.length === 2, 'rows=' + hRows.length);
  check('clothing list has 1 row', cRows.length === 1, 'rows=' + cRows.length);

  const opts = sel => [...sel.options].map(o => o.value);
  check('each row has a Move control', [...dRows, ...hRows, ...cRows].every(r => r.querySelector('select.mv')));
  check('dining row offers holiday + clothing, not itself', opts(dRows[0].querySelector('select.mv')).join() === ',holiday,clothing');
  check('holiday row offers dining + clothing, not itself', opts(hRows[0].querySelector('select.mv')).join() === ',dining,clothing');
  check('clothing row offers dining + holiday, not itself', opts(cRows[0].querySelector('select.mv')).join() === ',dining,holiday');

  console.log('\n--- pending foreign-currency entries ---');
  const settleBtns = $$('[data-settle]');
  check('two pending entries show a settle button', settleBtns.length === 2, 'buttons=' + settleBtns.length);
  const hotelBtn = settleBtns.find(b => b.dataset.cur === 'EUR' && Number(b.dataset.amt) === 840.5);
  check('button shows the original currency amount', hotelBtn && /EUR 840\.50/.test(hotelBtn.textContent), hotelBtn && hotelBtn.textContent);
  check('pending dining row notes it in the summary', /1 awaiting a rand amount/.test($('#lS').textContent), $('#lS').textContent);
  check('pending holiday row notes it in the summary', /1 awaiting a rand amount/.test($('[data-pot="holiday"] [data-f="lS"]').textContent));

  console.log('\n--- settle: confirm what the hotel cost in rand ---');
  promptAnswer = '16980,25';                              // South African decimal comma
  hotelBtn.click();
  const settled = await until(() => !$$('[data-settle]').some(b => b.dataset.cur === 'EUR' && Number(b.dataset.amt) === 840.5));
  check('the settle button disappears once settled', settled);
  check('the hotel now shows a rand amount', $$('[data-pot="holiday"] [data-f="list"] .item').some(r => /Hotel Colosseo/.test(r.textContent) && /16\s?980/.test(r.textContent)),
    $$('[data-pot="holiday"] [data-f="list"] .item').map(r => r.textContent.trim().slice(0, 60)).join(' || '));
  check('holiday spent now includes it', window.D.pots.holiday.spent === 2400 + 16980.25, 'spent=' + window.D.pots.holiday.spent);

  promptAnswer = null;                                    // Cancel
  const stillPending = $$('[data-settle]')[0];
  stillPending.click();
  await sleep(150);
  check('cancelling the prompt changes nothing', $$('[data-settle]').length === 1);

  promptAnswer = 'abc';
  $$('[data-settle]')[0].click();
  await sleep(150);
  check('a non-number is refused with a message', /Enter the rand amount/.test($('#flash').textContent) && $$('[data-settle]').length === 1, $('#flash').textContent);

  promptAnswer = '455.00';
  $$('[data-settle]')[0].click();
  await until(() => $$('[data-settle]').length === 0);
  check('second pending entry settled with a dot decimal too', $$('[data-settle]').length === 0);

  console.log('\n--- move: re-home an entry from the page ---');
  const ft = () => $$('[data-pot="holiday"] [data-f="list"] .item').find(r => /FlySafair/.test(r.textContent));
  check('FlySafair starts in holiday', !!ft());
  const sel = ft().querySelector('select.mv');
  sel.value = 'clothing';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const moved = await until(() => !ft());
  check('FlySafair left the holiday list', moved);
  check('and appears under clothing', $$('[data-pot="clothing"] [data-f="list"] .item').some(r => /FlySafair/.test(r.textContent)));
  check('the user is told how to make it stick', /merchant rule/i.test($('#flash').textContent), $('#flash').textContent);
  check('state agrees', window.D.pots.clothing.entries.some(e => e.name === 'FlySafair') && !window.D.pots.holiday.entries.some(e => e.name === 'FlySafair'));

  const meal = () => $$('#list .item').find(r => /Kloof Street/.test(r.textContent));
  const msel = meal().querySelector('select.mv');
  msel.value = 'holiday';
  msel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await until(() => !meal());
  check('a dining entry can move out too', !meal() && window.D.pots.holiday.entries.some(e => e.name === 'Kloof Street House'));
  check('dining list shrank accordingly', $$('#list .item').length === 1, 'rows=' + $$('#list .item').length);

  console.log('\n--- delete buttons still hit the right route per ledger ---');
  const delDining = $('#list .item [data-tx]');
  delDining.click();
  await until(() => $$('#list .item').length === 0);
  check('dining entry deleted', window.D.current.txns.length === 0);
  const delPot = $('[data-pot="holiday"] [data-f="list"] [data-pot-del]');
  const potBefore = window.D.pots.holiday.entries.length;
  delPot.click();
  await until(() => window.D.pots.holiday.entries.length === potBefore - 1);
  check('pot entry deleted', window.D.pots.holiday.entries.length === potBefore - 1);

  console.log('\n--- merchant rules from the Setup tab ---');
  check('existing rule is listed', /woolworths/.test($('#rules').textContent) && /Clothing/.test($('#rules').textContent), $('#rules').textContent.trim());
  $('#rM').value = 'ab';
  $('#addRule').click();
  await sleep(100);
  check('a too-short fragment is refused client-side', /at least 3 letters/.test($('#flash').textContent) && window.D.rules.length === 1);

  $('#rM').value = 'Hotel Colosseo';
  $('#rC').value = 'holiday';
  $('#addRule').click();
  await until(() => window.D.rules.length === 2);
  check('a new rule is saved and listed', window.D.rules.length === 2 && /hotel colosseo/.test($('#rules').textContent), $('#rules').textContent.trim());
  check('the input is cleared after saving', $('#rM').value === '');

  $('#rules [data-rule]').click();
  await until(() => window.D.rules.length === 1);
  check('a rule can be removed with the x', window.D.rules.length === 1);

  console.log('\n--- hostile names cannot inject markup ---');
  await h.card({ v: 2, mcc: '5812', name: '<img src=x onerror=alert(1)>', amount: 77, currency: 'zar' });
  await h.card({ v: 2, mcc: '4511', name: '"><script>window.__pwned=1</script>', amount: 88, currency: 'zar' });
  // trigger a real refresh the way the page does on tab focus
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  doc.dispatchEvent(new window.Event('visibilitychange'));
  await until(() => window.D.current.txns.some(t => /img src/.test(t.name)));
  check('hostile names reached the page data', window.D.current.txns.some(t => /img src/.test(t.name)));
  check('no <img> element was injected into the list', !$('#list img'));
  check('no <script> element was injected', !$$('[data-f="list"] script').length && !window.__pwned);
  check('the name is shown as text', /<img src=x/.test($('#list').textContent));

  console.log('\n--- nothing broke along the way ---');
  check('no script errors during the whole session', errors.length === 0, errors.join(' | '));

  done('UI tests passed');
})();
