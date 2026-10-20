const { makeHarness, reporter } = require('./harness.cjs');
const { check, done } = reporter();

(async () => {
  const h = await makeHarness();

  console.log('--- accrual across year ends, rate changes, drawdown (unchanged behaviour) ---');
  let r = await h.app('/api/pot/settings', { pot: 'holiday', monthly: 2000, startMonth: '2024-06' });
  let p = r.json.pots.holiday;
  const now = new Date(Date.now() + 2 * 3600e3);
  const expectMonths = (now.getUTCFullYear() - 2024) * 12 + (now.getUTCMonth() + 1 - 6) + 1;
  check('months counted exactly across year ends', p.months === expectMonths, p.months + ' vs ' + expectMonths);
  check('accrued = months x rate', p.accrued === expectMonths * 2000);

  const before = p.accrued;
  r = await h.app('/api/pot/settings', { pot: 'holiday', monthly: 3000 });
  p = r.json.pots.holiday;
  check('a rate change re-rates only the current month', p.accrued === before + 1000, p.accrued + ' vs ' + (before + 1000));
  check('two segments', p.rates.length === 2);

  r = await h.app('/api/pot/entry', { pot: 'holiday', name: 'Deposit', amount: 5000, date: '2026-04-02' });
  p = r.json.pots.holiday;
  check('manual entry draws the pot down', p.spent === 5000 && p.available === p.accrued - 5000);
  check('manual entry attributed from the token', p.entries[0].by === 'Tester' && p.entries[0].src === 'manual');

  r = await h.app('/api/pot/entry/delete', { pot: 'holiday', id: p.entries[0].id });
  check('delete works', r.json.pots.holiday.entries.length === 0);

  r = await h.app('/api/pot/entry', { pot: 'clothing', name: 'Jacket', amount: 4000 });
  check('overdrawn pot goes negative, never blocks', r.json.pots.clothing.available < 0 && r.status === 200);

  console.log('\n--- eating-out is untouched ---');
  r = await h.app('/api/tx', { name: 'Ramen', amount: 180 });
  check('manual dining entry still works', r.status === 200 && r.json.current.spent === 180);
  r = await h.app('/api/state');
  check('remaining reflects it', r.json.current.remaining === 3000 - 180);
  r = await h.app('/api/tx/delete', { id: r.json.current.txns[0].id });
  check('dining delete still works', r.json.current.spent === 0);

  console.log('\n--- new routes need Access, old routes still do ---');
  const anon = await h.worker.fetch(new Request('https://x.dev/api/state'), h.env);
  check('anonymous state read refused', anon.status === 401);

  done('pot regression passed');
})();
