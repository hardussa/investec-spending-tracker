/* ============================================================
   Spend tracking — Investec card code
   Paste into main.js in the Programmable Card IDE.
   Simulate before deploying to a live card.

   TRACKING ONLY. This code never declines a transaction.

   env.json needs: workerUrl, cardKey, cardHolder,
                   cfAccessClientId, cfAccessClientSecret
   (copy card/env.example.json, fill it in, and never commit it)

   workerUrl            https://<worker-name>.<your-subdomain>.workers.dev
   cardKey              the shared secret you set as CARD_KEY on the Worker.
                        NOT Investec's own CardKey for your card. Despite the
                        similar name they are unrelated, and using the Investec
                        one here just produces 401s.
   cardHolder           a short label shown next to each entry (e.g. a first name)
   cfAccessClientId /   the Cloudflare Access Service Token that protects
   cfAccessClientSecret /api/card. Treat the secret like a password.

   HOW SPEND IS ALLOCATED
   This code does not decide which budget a purchase belongs to.
   After every approved transaction it reports the raw facts
   (merchant code, name, amount, currency) to the Worker, which
   files it under eating out, holiday or clothing, or drops it if
   it is none of those. The merchant-code table and your merchant
   rules live in the Worker, so changing them never means
   redeploying this card.

   Every branch logs, so the executions log always shows which
   path was taken, including the "did nothing" paths.
   ============================================================ */

const rands = cents => cents / 100;

// Investec nests merchant info under `merchant`, not top-level:
//   { merchant: { category: { code }, name, city, country }, centsAmount, currencyCode, ... }
const getMerchantCode = txn => txn.merchant && txn.merchant.category && txn.merchant.category.code;
const getMerchantName = txn => (txn.merchant && txn.merchant.name) || 'unknown merchant';
const getCurrency = txn => String(txn.currencyCode || 'zar').toLowerCase();

async function callWorker(body) {
  console.log('callWorker -> ' + process.env.workerUrl + '/api/card | body=' + JSON.stringify(body));
  const r = await fetch(process.env.workerUrl + '/api/card', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-card-key': process.env.cardKey,
      'CF-Access-Client-Id': process.env.cfAccessClientId,
      'CF-Access-Client-Secret': process.env.cfAccessClientSecret
    },
    body: JSON.stringify(body)
  });
  console.log('callWorker <- status=' + r.status);
  if (r.status === 403) {
    console.log('403 from worker — check cfAccessClientId/cfAccessClientSecret env vars ' +
                'and the Access Service Token policy before assuming the worker logic is broken.');
  }
  if (!r.ok) throw new Error('worker returned ' + r.status);
  const json = await r.json();
  console.log('callWorker <- body=' + JSON.stringify(json));
  return json;
}

/* ---------- 2 second window ---------- */
// Always approves, with no network call, so this can never slow or block a swipe.
const beforeTransaction = async (authorization) => {
  console.log('beforeTransaction: approving. merchantCode=' + getMerchantCode(authorization) +
              ', merchantName=' + getMerchantName(authorization) +
              ', centsAmount=' + authorization.centsAmount +
              ', currency=' + getCurrency(authorization));
  return true;
};

/* ---------- 15 second window ---------- */
// Reports every approved transaction. The Worker decides what it is and
// whether it is tracked at all, so there is no filtering here.
const afterTransaction = async (transaction) => {
  const merchantCode = getMerchantCode(transaction);
  const merchantName = getMerchantName(transaction);
  const currency = getCurrency(transaction);
  console.log('afterTransaction start. merchantCode=' + merchantCode +
              ', merchantName=' + merchantName + ', centsAmount=' + transaction.centsAmount +
              ', currency=' + currency);

  // No date is sent. The Worker stamps it in South African time; a UTC date
  // from here would file the first two hours of every month under the last.
  // v:2 tells the Worker this is category-aware card code, so a transaction
  // missing its merchant code is ignored rather than treated as dining.
  const payload = {
    v: 2,
    mcc: merchantCode == null ? undefined : String(merchantCode),
    name: merchantName,
    amount: rands(transaction.centsAmount),
    currency: currency,
    by: process.env.cardHolder || 'card'
  };

  try {
    const res = await callWorker(payload);
    if (res.ignored) {
      console.log('Not tracked: ' + res.reason + '.');
    } else if (res.duplicate) {
      console.log('Already logged under ' + res.category + '. Skipped.');
    } else if (res.pending) {
      console.log('Logged under ' + res.category + ' as ' + currency.toUpperCase() + ' ' + payload.amount +
                  '. Open the app and set the rand amount; it counts as R0 until then.');
    } else {
      const left = res.remaining < 0
        ? 'R' + Math.round(-res.remaining) + ' over'
        : 'R' + Math.round(res.remaining) + ' left';
      console.log('Logged under ' + res.category + ' (matched by ' + res.via + '). ' + left + '.');
    }
  } catch (e) {
    console.log('Could not log this one: ' + e.message);
  }
};

const beforeDecline = async () => {
  console.log('beforeDecline called (no-op).');
};

// This code never declines, so a decline here came from the bank (funds, limits,
// card status). A decline is not spend, so nothing is allocated.
const afterDecline = async (transaction) => {
  console.log('afterDecline: declined by the bank, not by this code. merchantName=' +
              getMerchantName(transaction) + ', merchantCode=' + getMerchantCode(transaction) +
              '. Nothing tracked.');
};
