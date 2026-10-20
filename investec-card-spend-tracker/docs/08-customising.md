# 08. Customising

The project is a single Worker file and a single card file, so most changes are small edits. This guide lists exactly where each assumption lives.

After **any** change, run the tests and deploy:

```bash
npm test
npm run deploy
```

If you change `card/main.js`, republish it to the card too ([04-investec-card.md](04-investec-card.md)).

---

## Timezone

By default the Worker works in **South African Standard Time (UTC+2)**. The day, and therefore the month, rolls over at midnight there. This matters twice: a purchase at 00:30 on the 1st must land in the new month, and the card sends no date of its own, so the Worker's clock decides.

### If your timezone never changes for daylight saving

Change one number in `src/worker.js`:

```js
const SAST_OFFSET_MS = 2 * 3600e3;     // your UTC offset in hours, times 3600e3
```

Also change the matching number in the page script, where today's date is pre-filled in the forms (search for `2*3600e3`).

### If your timezone observes daylight saving

A fixed offset is wrong for part of the year. Replace the four lines that define `SAST_OFFSET_MS`, `sastNow`, `todayISO` and `nowMonth` with:

```js
const TIMEZONE = 'Europe/London';     // an IANA timezone name
const todayISO = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(Date.now()));
const nowMonth = () => todayISO().slice(0, 7);
```

Notes:

- `'en-CA'` is used only because that locale formats dates as `YYYY-MM-DD`.
- Write `new Date(Date.now())`, not `new Date()`. The tests simulate time by replacing `Date.now`, and `new Date()` ignores that.
- In the page script, replace `new Date(Date.now()+2*3600e3).toISOString().slice(0,10)` with the same `Intl.DateTimeFormat` call (without the `Date.now()` wrapper, as the browser has no test stub).
- This swap was verified against the test suite with `Africa/Johannesburg`, and the formatter was checked at month boundaries for London (summer and winter), New York and Sydney.

The tests in `test/allocation.test.cjs` that check "dated 1 November, not 31 October" are written for UTC+2. If you change timezone, adjust their UTC instants (they are commented) so they still describe your local midnight.

---

## Currency

The app assumes **South African rand**. To change it, there are four places:

1. **Card base currency, in `src/worker.js`.** The card route treats any currency other than `zar` as foreign:

   ```js
   const foreign = cur.toLowerCase() !== 'zar';
   ```

   Change `'zar'` to your currency code in lowercase, for example `'gbp'`. The card code sends the currency as Investec reports it, lowercased.
2. **Display formatting, in the page script.** Two helpers, `fmt` and `fmt2`, format money:

   ```js
   new Intl.NumberFormat('en-ZA', {style:'currency', currency:'ZAR', ...})
   ```

   Change both the locale and `currency`. The month and day labels also use `'en-ZA'`.
3. **The letter `R` in messages**: the "Only R… spare" error in `src/worker.js`, and the log lines in `card/main.js` that print `'R' + …`.
4. **Tests.** Several assertions mention `R` amounts or `zar`. Update them.

Pending foreign amounts are then about *your* currency: "set R" in the button label becomes your symbol; search for `set R` in the page script.

---

## Merchant codes and categories

### Change which codes go where

Edit `MCC_RANGES` in `src/worker.js`. Each category is a list of inclusive `[from, to]` ranges:

```js
const MCC_RANGES = {
  dining: [[5811, 5814], [5462, 5462]],
  // ...
};
```

Move a code between lists, add one as `[5912, 5912]` (a single code is a range of one), or add a range. Deploy the Worker. **The card does not need to change.** Run the tests; `test/allocation.test.cjs` lists expected codes and edges, and will tell you which expectations you have changed.

Investec's own list of codes and descriptions is available from the API (`GET /za/v1/cards/merchants`).

### Prefer rules for exceptions

For a single merchant, a **merchant rule** in the app (Setup) is better than editing the table, because it needs no deploy. See [05-how-spend-is-allocated.md](05-how-spend-is-allocated.md#2-merchant-rules).

### Add a new category (a third pot)

Eating out is special; holiday and clothing are "pots" that share all their code, so a new pot is mostly copy and paste. In `src/worker.js`:

1. **`POTS`**: add an entry with a `label`, a `noun` and a `defaultMonthly`, for example `travel: { label: 'Travel', noun: 'trip', defaultMonthly: 1000 }`. `POT_KEYS` and `CATEGORIES` follow from it automatically.
2. **`CAT_LABEL`**: add its display name.
3. **`MCC_RANGES`**: add its list of codes.
4. **The page markup**: add a tab button (`data-t="travel"`) and copy one of the two existing `<section data-p="holiday" data-pot="holiday">` blocks, changing `holiday` to your new key in both `data-p` and `data-pot`, and updating the headings and wording.
5. **The page script**: add the new key to the list `['holiday','clothing']` where the handlers are wired, to the two `renderPot(...)` calls, and to the two `potEl(...,'eD').value=today` lines.
6. **The rule picker**: add an `<option>` for it in the `#rC` select under Merchant rules.
7. **Tests**: copy a holiday assertion or two for the new pot.

The state, routes, move, rules, duplicate detection and card reporting all work by category key and need no change. Steps 1 to 3 were verified against the test harness: a card report for a new code lands in the new pot, appears in the state, and can be moved, ruled and configured. **Steps 4 to 6 edit the page and are not covered by the shipped tests**, so open the app and click through the new tab, add an entry, move it and delete it before you rely on it.

> The card code needs no change either, and does not know categories exist.

---

## Names and wording

| To change | Where |
| --- | --- |
| The app's name on the home screen | `MANIFEST` (`name`, `short_name`) in `src/worker.js` |
| The browser tab title and sign-in heading | `<title>` and the `<h2>` inside `<div id="gate">` |
| Section headings like "Log a meal" or "Can we afford it?" | The `PAGE` string in `src/worker.js` |
| The default monthly eating-out budget | `settings.monthlyBudget` in `BLANK` (3000 by default) |
| The default monthly amount for each pot | `defaultMonthly` in `POTS` |
| How names are shown for signed-in people | `shortName` (first part of the email before the `@`) |

Any text you add to the page goes inside a JavaScript template literal. Avoid backticks and `${` in client code. Keep quotes escaped as the surrounding code does.

---

## Limits

All in the constants near the top of `src/worker.js`:

| Constant | Default | What it caps |
| --- | --- | --- |
| `MAX_BODY` | 8192 | Request body size in bytes |
| `MAX_TXNS` | 400 | Eating-out entries per month |
| `MAX_POT_ENTRIES` | 500 | Entries per pot |
| `MAX_GOALS` | 30 | Splurges |
| `MAX_RULES` | 50 | Merchant rules |
| `MAX_NAME` | 60 | Characters in any name |
| `SNAPSHOT_DAYS` | 45 | How long daily snapshots are kept |

Everything lives in one KV value, and KV values have a size limit (Cloudflare documents it). If you raise the entry caps substantially, check the size of your document first.

---

## Using a custom domain

The `workers.dev` address suits personal projects. If you own a domain on Cloudflare you can serve the Worker from it with a route or custom domain, then create the two Access applications for that hostname instead. Update the card's `workerUrl` and set `workers_dev = false` in `wrangler.toml` if you want to switch the `workers.dev` address off. See Cloudflare's documentation on Workers routes and custom domains.

---

## Keep the tests honest

The tests are there so a change that quietly weakens security fails loudly. Before you finish customising:

- `npm test` passes.
- The security tests in `test/security.test.cjs` still pass **unchanged**. If you had to edit one to make it pass, stop and work out why.
- `python scripts/scan_for_secrets.py` passes before you publish a fork.
