# 09. API reference

Every route the Worker serves. Useful if you want to script against it, build another client or write your own tests.

All app responses are JSON with `Cache-Control: no-store`. Errors look like `{"error": "message"}`.

## Authentication at a glance

| Routes | Credential the Worker checks |
| --- | --- |
| `GET /`, `/manifest.json`, `/robots.txt`, `/icon.svg`, `/sw.js` | None. Cloudflare Access sits in front; the Worker serves only static content. |
| `POST /api/card` | Header `x-card-key` equal to the `CARD_KEY` secret. |
| Every other `/api/*` route | A valid Cloudflare Access token for a person with an email address. |

The Access token is read from the `Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie (how a browser arrives). The checks are listed in [06-security.md](06-security.md#what-the-worker-verifies-on-every-request-to-api).

| Status | Meaning on app routes |
| --- | --- |
| 401 | `{"error":"Not signed in.","signin":true}` |
| 503 | `{"error":"Access is not configured on this Worker.","setup":true}`: `ACCESS_TEAM` or `ACCESS_AUD` is missing |
| 400 | Bad or oversized body, or invalid values |
| 404 | Unknown route, or a `GET` on a `POST`-only route |
| 409 | A cap was reached (entries per month or pot, goals, rules) |

Request bodies are JSON, at most 8 KB, sent with `POST`.

---

## The card

### `POST /api/card`

Headers: `x-card-key: <CARD_KEY>`, `Content-Type: application/json`. In production the request also passes Cloudflare Access with the service-token headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`, but those are checked by Access, not by the Worker.

Body:

| Field | Type | Notes |
| --- | --- | --- |
| `v` | number | Send `2`. Marks the caller as category-aware. See "Legacy callers". |
| `mcc` | string or number | Merchant category code, for example `"5812"`. |
| `name` | string | Merchant name. Control characters are stripped and it is trimmed to 60 characters. Default `Card purchase`. |
| `amount` | number | Above 0 and at most 1,000,000, in the units of `currency`. Rounded to 2 decimals. |
| `currency` | string | Three letters, case-insensitive. Default `zar`. Anything other than `zar` is held as pending. |
| `by` | string | A label for the entry. Default `card`. |
| `date` | `YYYY-MM-DD` | Optional. Ignored unless within the last 6 years or the next 40 days. The shipped card code does not send it, so the Worker stamps today in local time. |

Responses (all `200` unless noted):

```jsonc
// Stored.
{ "ok": true, "category": "dining", "via": "mcc", "pending": false, "remaining": 2875 }

// Not a tracked category. Nothing was stored.
{ "ok": true, "ignored": true, "reason": "no category for merchant code 5411" }

// Same merchant, day and amount within two minutes, in any category.
{ "ok": true, "duplicate": true, "category": "dining", "remaining": 2875 }
```

| Field | Meaning |
| --- | --- |
| `category` | `dining`, `holiday` or `clothing`. |
| `via` | How it was classified: `rule`, `mcc` or `legacy`. |
| `pending` | `true` when the currency was not rand, so the entry counts as R0 until settled. |
| `remaining` | For `dining`, what is left this month (negative if over). For a pot, its available balance. |

Errors:

| Status | Body | Cause |
| --- | --- | --- |
| 400 | `{"error":"bad request"}` | Body missing, not JSON, or over 8 KB |
| 400 | `{"error":"bad currency"}` | Not three letters |
| 400 | `{"error":"bad amount"}` | Not a number in range |
| 401 | `{"error":"unauthorised"}` | Missing, wrong or unset card key |
| 409 | `{"error":"That month already has 400 entries."}` | Cap reached |
| 409 | `{"error":"That pot already has 500 entries."}` | Cap reached |
| 500 | `{"error":"could not allocate"}` | Unexpected fault, contained so it cannot corrupt state |

**Legacy callers.** Early versions of the card code sent no `mcc` and no `v`, and only ever reported restaurant spend. A body with neither is treated as dining so those versions keep working. A caller that sends `v` (as the shipped code does) but no `mcc` has the transaction **ignored**, never filed as dining by mistake.

---

## Reading state

### `GET /api/state`

Returns everything the page needs:

```jsonc
{
  "me": "alex@example.com",
  "current": {                       // this month, eating out
    "key": "2026-10", "budget": 3000, "carriedIn": 0, "spent": 125.5,
    "stashed": 0, "available": 3000, "remaining": 2874.5,
    "txns": [ /* entries */ ]
  },
  "pot": 0,                          // the weekend pot: total ever stashed
  "months": [ /* one summary row per month, newest first */ ],
  "goals": [ { "id": "…", "label": "Weekend away", "amount": 2500 } ],
  "settings": { "monthlyBudget": 3000, "carryDeficit": true },
  "pots": {
    "holiday": {
      "key": "holiday", "label": "Holiday", "noun": "trip", "started": "2026-01",
      "monthly": 2000, "accrued": 20000, "spent": 4200, "available": 15800,
      "months": 10, "rates": [ { "from": "2026-01", "monthly": 2000 } ],
      "entries": [ /* entries */ ]
    },
    "clothing": { /* same shape */ }
  },
  "cats": [ { "key": "dining", "label": "Eating out" }, /* … */ ],
  "rules": [ { "match": "woolworths", "category": "clothing" } ]
}
```

An **entry** as the app sees it:

```jsonc
{ "id": "…", "date": "2026-10-19", "name": "Corner Cafe", "amount": 125.5,
  "by": "Sam", "src": "card", "pending": false, "foreign": null }
```

For a pending foreign entry, `pending` is `true`, `amount` is `0`, and `foreign` is `{ "currency": "EUR", "amount": 840.5 }`.

---

## Eating out

### `POST /api/tx`: log a meal by hand
`{ "name": "Ramen", "amount": 180, "date": "2026-10-19" }`. `name` defaults to `Eating out`; `date` defaults to today. The entry's `by` is set from the signed-in person, never from the request. Returns the new state.

### `POST /api/tx/delete`
`{ "id": "<entry id>" }`. Removes the entry from whichever month holds it.

### `POST /api/stash`: move surplus into the weekend pot
`{ "amount": 500 }` moves money in; a negative amount returns it. Moving in more than this month has spare returns `400`.

### `POST /api/goal`: add or remove a splurge
Add: `{ "label": "Weekend away", "amount": 2500 }`. Remove: `{ "remove": "<goal id>" }`. At most 30 goals.

### `POST /api/settings`
`{ "monthlyBudget": 3500, "carryDeficit": false }`. Either field is optional. The budget applies from this month; earlier months keep theirs.

---

## Holiday and clothing pots

### `POST /api/pot/entry`
`{ "pot": "holiday", "name": "Flights", "amount": 4200, "date": "2026-04-02" }`. `pot` is required.

### `POST /api/pot/entry/delete`
`{ "pot": "holiday", "id": "<entry id>" }`

### `POST /api/pot/settings`
`{ "pot": "holiday", "monthly": 2500, "startMonth": "2025-06" }`. Both fields are optional.

- `monthly` adds a rate from **this month on**; earlier months keep what they earned.
- `startMonth` (`YYYY-MM`) backdates when the pot began. It cannot be in the future or more than 600 months back.

---

## Corrections

### `POST /api/alloc/move`
`{ "from": "dining", "to": "holiday", "id": "<entry id>" }`. `from` and `to` are category keys and must differ. The entry is looked up **in `from` only**. If the destination is full the call returns `409` and nothing changes.

### `POST /api/alloc/settle`
`{ "ledger": "holiday", "id": "<entry id>", "amount": 16980.25 }`. Gives a pending foreign entry its rand amount. `404` if the entry is not pending.

### `POST /api/rule`
`{ "match": "woolworths", "category": "clothing" }` adds or changes a rule. An empty or null `category` removes it. `match` is normalised (lowercase, non-alphanumerics become spaces) and must be 3 to 30 characters. At most 50 rules.

---

## Static routes

| Route | Content |
| --- | --- |
| `GET /` | The web app, with a per-request CSP nonce. |
| `GET /manifest.json` | The web app manifest. |
| `GET /icon.svg` | The app icon. |
| `GET /sw.js` | A minimal service worker. |
| `GET /robots.txt` | `Disallow: /` |

---

## Trying the API yourself

Calls need a real Access token, so the easiest route for the **card** endpoint is the `curl` tests in [03-cloudflare-access.md](03-cloudflare-access.md#step-9-prove-both-doors-work). For everything else, `test/harness.cjs` shows how to call the Worker in-process with signed test tokens and no network, which is also the quickest way to explore behaviour while developing.
