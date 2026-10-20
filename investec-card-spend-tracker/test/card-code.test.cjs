const fs = require('fs');
const vm = require('vm');
const { makeHarness, reporter } = require('./harness.cjs');
const { check, done } = reporter();

(async () => {
  const h = await makeHarness();

  // Seed a known dining budget so over/under-budget decisions are deterministic.
  await h.app('/api/settings', { monthlyBudget: 1000, carryDeficit: true });

  // Load the card code the way Investec runs it: top-level consts, a process.env, a fetch.
  const calls = [];
  const logs = [];
  const envVars = {
    workerUrl: 'https://worker.test', cardKey: h.CARD_KEY, cardHolder: 'Me',
    blockWhenOver: 'true', hardCeiling: '0',
    cfAccessClientId: 'id-123', cfAccessClientSecret: 'secret-456'
  };
  const ctx = vm.createContext({
    process: { env: envVars },
    console: { log: (...a) => logs.push(a.join(' ')) },
    JSON, Number, String, Math, Date, Error, Promise,
    fetch: async (url, opts) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      const res = await h.worker.fetch(new Request(url, opts), h.env);
      return res;
    }
  });
  const code = fs.readFileSync(process.argv[2] || require('path').resolve(__dirname, '..', 'card', 'main.js'), 'utf8');
  const card = vm.runInContext(code + '\n;({ beforeTransaction, afterTransaction, beforeDecline, afterDecline })', ctx);

  // Payloads shaped like the runtime object in the Investec spec: nested merchant, numeric cents.
  const txn = (code, name, cents, currency = 'zar') => ({
    accountNumber: '10011001100', dateTime: '2026-10-13T08:00:00.000Z',
    centsAmount: cents, currencyCode: currency, type: 'card', reference: 'simulation',
    card: { id: '1010101' },
    merchant: { category: { code: String(code), key: 'k', name: 'n' }, name, city: 'Cape Town', country: { code: 'ZA' } }
  });
  const reset = () => { calls.length = 0; logs.length = 0; };

  console.log('--- the card code can no longer decline anything ---');
  check('no decline path exists in the source', !/return\s+false/.test(code));
  check('the old blocking settings are gone from the source', !/blockWhenOver|hardCeiling/.test(code));

  // Worst case for the old logic: block mode on, a tiny ceiling, the budget long
  // blown, and the worker unreachable. It must still approve, and not even try.
  envVars.blockWhenOver = 'true'; envVars.hardCeiling = '1';
  await h.app('/api/settings', { monthlyBudget: 1 });
  let attempts = 0;
  const realFetch = ctx.fetch;
  ctx.fetch = async () => { attempts++; throw new Error('network down'); };

  const swipes = [
    ['R2,500 dinner against a R1 budget', txn(5812, 'Fancy Place', 250000)],
    ['foreign dining', txn(5812, 'Trattoria Roma', 25000, 'eur')],
    ['R9,000 flight', txn(4511, 'FlySafair', 900000)],
    ['R4,500 shoes', txn(5661, 'Total Sports', 450000)],
    ['groceries', txn(5411, 'Checkers', 99900)],
    ['a payload with no merchant at all', { centsAmount: 5000, currencyCode: 'zar' }],
    ['an empty object', {}]
  ];
  for (const [label, t] of swipes) {
    reset();
    const ok = await card.beforeTransaction(t);
    check(label + ': approved', ok === true, 'ok=' + ok);
  }
  check('beforeTransaction made no network attempt in any case', attempts === 0, 'attempts=' + attempts);
  ctx.fetch = realFetch;
  envVars.blockWhenOver = 'false'; envVars.hardCeiling = '0';
  await h.app('/api/settings', { monthlyBudget: 1000 });

  console.log('\n--- afterTransaction: everything is reported, the worker decides ---');
  reset();
  await card.afterTransaction(txn(4511, 'FlySafair', 240000));
  check('flight reported with v2, code, currency', calls.length === 1 &&
    calls[0].body.v === 2 && calls[0].body.mcc === '4511' && calls[0].body.currency === 'zar' && calls[0].body.amount === 2400,
    JSON.stringify(calls[0] && calls[0].body));
  check('no date is sent (worker stamps it in SAST)', calls[0] && !('date' in calls[0].body));
  check('carries the Access service token', calls[0].headers['CF-Access-Client-Id'] === 'id-123');
  check('log says where it went', logs.some(l => /Logged under holiday/.test(l)), logs[logs.length - 1]);
  let st = h.stored();
  check('flight is in the holiday pot', st.pots.holiday.entries.some(e => e.name === 'FlySafair' && e.amount === 2400));

  reset();
  await card.afterTransaction(txn(5661, 'Total Sports', 180000));
  check('shoes land in clothing', h.stored().pots.clothing.entries.some(e => e.name === 'Total Sports' && e.amount === 1800));

  reset();
  await card.afterTransaction(txn(5812, 'Kloof Street House', 26000));
  check('meal lands in dining', Object.values(h.stored().months).some(m => m.txns.some(t => t.name === 'Kloof Street House')));

  reset();
  const before = JSON.stringify(h.stored());
  await card.afterTransaction(txn(5411, 'Checkers', 99900));
  check('groceries are sent and dropped by the worker', calls.length === 1 && logs.some(l => /Not tracked/.test(l)), logs[logs.length - 1]);
  check('nothing stored for groceries', JSON.stringify(h.stored()) === before);

  reset();
  await card.afterTransaction(txn(7011, 'Hotel Colosseo', 84050, 'eur'));
  check('foreign hotel reported as EUR', calls[0].body.currency === 'eur' && calls[0].body.amount === 840.5);
  check('log tells you to set the rand amount', logs.some(l => /set the rand amount/.test(l)), logs[logs.length - 1]);
  const pend = h.stored().pots.holiday.entries.find(e => e.name === 'Hotel Colosseo');
  check('held as pending at R0', pend && pend.pending === true && pend.amount === 0);

  reset();
  await card.afterTransaction(txn(5812, 'Kloof Street House', 26000));
  check('a repeat is reported as already logged', logs.some(l => /Already logged under dining/.test(l)), logs[logs.length - 1]);

  console.log('\n--- failure and malformed-input handling ---');
  reset();
  const noMerchant = { centsAmount: 5000, currencyCode: 'zar' };       // no merchant object at all
  await card.afterTransaction(noMerchant);
  check('a payload with no merchant is ignored, not misfiled as dining',
    calls[0].body.v === 2 && !('mcc' in calls[0].body) && logs.some(l => /Not tracked: no merchant code/.test(l)),
    logs[logs.length - 1]);

  reset();
  envVars.cardKey = 'wrong';
  await card.afterTransaction(txn(4511, 'FlySafair', 100000));
  check('a rejected call is logged, not thrown', logs.some(l => /Could not log this one: worker returned 401/.test(l)), logs[logs.length - 1]);
  envVars.cardKey = h.CARD_KEY;

  console.log('\n--- bank declines are logged, never tracked as spend ---');
  reset();
  await card.afterDecline(txn(5812, 'Fancy Place', 250000));
  check('decline never calls the worker', calls.length === 0);
  check('the log says the bank declined it, not this code', logs.some(l => /declined by the bank, not by this code/.test(l)), logs[logs.length - 1]);
  check('and no longer claims the budget is spent', !logs.some(l => /budget is spent/.test(l)));
  await card.beforeDecline();

  done('card code tests passed');
})();
