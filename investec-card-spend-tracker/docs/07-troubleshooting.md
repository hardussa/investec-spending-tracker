# 07. Troubleshooting

Find your symptom, check the likely cause, apply the fix. Several of these are real problems that came up while this project was being built.

**Before you paste anything into a forum or issue**, read [06-security.md](06-security.md#sharing-logs-screenshots-and-questions-safely).

---

## First: find out which part is failing

The system has four links. Find the first one that is broken and fix that before anything else.

| Link | How to check it |
| --- | --- |
| **1. Card code runs** | `python scripts/investec_card.py logs --limit 5`, or the IDE's logs. You should see executions. |
| **2. Card reaches Cloudflare Access** | The log line `callWorker <- status=` should say `200`. A `403` or `401` is here. |
| **3. The Worker accepts it** | `status=401` with the Worker's own JSON means the shared secret is wrong. |
| **4. It is stored and shown** | Open the app. Check the right tab, and the `Not tracked` / `Logged under` log line. |

### Reading the card's logs

The card code logs every decision, so a log is never silently empty. The key lines:

| Log line | Meaning |
| --- | --- |
| `beforeTransaction: approving. merchantCode=5812, ...` | The code ran and read the transaction correctly. |
| `callWorker <- status=200` | The Worker accepted the report. |
| `Logged under dining (matched by mcc). R2875 left.` | Success. |
| `Logged under holiday as EUR 840.5. Open the app and set the rand amount` | Success; foreign spend is held pending. |
| `Not tracked: no category for merchant code 5411.` | Working as designed: that merchant is not in any category. |
| `Already logged under dining. Skipped.` | Duplicate detection (below). |
| `Could not log this one: worker returned 401` | See "Card log says 401". |
| `403 from worker — check cfAccessClientId...` | See "Card log says 403". |

---

## The card side

### The log says `merchantCode=undefined`

The transaction object Investec passes to your code is **nested**: the merchant code is at `merchant.category.code` and the name at `merchant.name`. The simulator's *input*, by contrast, is flat (`merchantCode`, `merchantName`). Code written for the flat shape reads `undefined` at runtime.

`card/main.js` already reads the nested shape. If you adapted it, check you did not reintroduce `transaction.merchantCode`. The merchant code also arrives as a **string** at runtime (`"5812"`), so compare with `Number(...)` if you write your own checks.

### The logs array is empty

If an execution has `"logs": []`, your code returned without calling `console.log`. That usually means an early `return` that skips every log line. `card/main.js` logs in every branch, so an empty log from this code means either the code on the card is not this code, or it was saved but not **published**. Run `python scripts/investec_card.py show --published` to see what is live.

### Simulates fine, but real purchases do not appear

Simulations run the code you submit. **Real transactions run only the published code.** Check, in order:

1. `python scripts/investec_card.py show --published` prints the code you expect. If not, run `deploy` (or publish in the IDE).
2. The card is **Programmable = yes** in `python scripts/investec_card.py cards`.
3. `python scripts/investec_card.py logs --limit 5` shows `(live)` executions after your purchase. If it does, the card code ran and the problem is later in the chain; read its log lines.
4. The card's environment variables are present. `env-push` replaces them all; a push from an incomplete `env.json` would have deleted some.

### Card log says `403` from the Worker

A 403 means **Cloudflare Access refused the request before it reached your Worker.** Check:

1. `cfAccessClientId` and `cfAccessClientSecret` in the card's environment variables are both present and correct (no stray spaces or quotes).
2. The **service token has not expired** (Zero Trust, Access controls, Service credentials, Service Tokens). Expiry is the usual cause of tracking that worked and then stopped.
3. App 2's policy action is **Service Auth** and its Include rule selects *this* token.
4. App 2 covers the path **`/api/card`** on the right hostname.
5. `workerUrl` in the environment variables has no trailing slash and no path.

Run Test A, B and C from [03-cloudflare-access.md](03-cloudflare-access.md#step-9-prove-both-doors-work) from a terminal. They isolate whether it is the token, the card key or the code.

### Card log says `401` from the Worker

A 401 **with the Worker's JSON** (`{"error":"unauthorised"}`) means Access let the request through, and the Worker rejected the shared secret. The `cardKey` in the card's environment variables does not equal the Worker's `CARD_KEY` secret. The usual causes:

- You put **Investec's CardKey** (like `1010101`) into `cardKey`. See the [naming trap](04-investec-card.md#read-this-first-a-naming-trap).
- A stray newline or space when you pasted either value.
- You regenerated one and not the other.

Fix by setting both again from the same value.

A 401 that is **not** the Worker's JSON, with the "401 Response for Service Auth policies" option on, comes from Access: see the 403 checklist above.

### `callWorker` throws, or the log shows a non-JSON error

The Worker address is wrong or unreachable. Open `workerUrl` in a browser: you should reach the Worker's page. Check you used `https://`.

### Repeating a simulation records nothing

Duplicate detection treats the same merchant name, day and amount within two minutes as one purchase. Vary the amount or wait. See [05-how-spend-is-allocated.md](05-how-spend-is-allocated.md#5-duplicates).

### I deployed, but my environment variables disappeared

`env-push` and the Investec API **replace all** variables; there is no patch. Keep one complete `card/env.json` and push the whole file each time.

---

## Signing in

### The page says "Access is not configured on this Worker"

`ACCESS_TEAM` or `ACCESS_AUD` is not set. Set both as Worker secrets ([guide 03, Step 5](03-cloudflare-access.md#step-5-give-the-worker-its-access-secrets)). They take effect in seconds; no redeploy needed.

### I sign in with the code, then the app says "Your session ended" or "You are not signed in", in a loop

Access accepted you but the Worker rejected the token. In order of likelihood:

1. **`ACCESS_AUD` is from the wrong Access app.** It must be App 1's tag (the people app), not the card app's.
2. **`ACCESS_TEAM` has extra text.** It must be only the team name: `your-team`, not `your-team.cloudflareaccess.com` and not a URL.
3. **Your email is not in `ALLOWED_EMAILS`**, even though it is in the Access policy. Both lists must include you. Capital letters and spaces do not matter.
4. **You are using a different team** than the one whose name you entered.
5. Your device clock is far wrong (tokens have an expiry).

The Worker deliberately returns a generic "not signed in" and does not say which check failed, so an attacker learns nothing. Work through the list.

### Google shows `Error 400: redirect_uri_mismatch`

The **Authorized redirect URI** in your Google OAuth client does not exactly match what Cloudflare sends. It must be, character for character:

```
https://YOUR-TEAM.cloudflareaccess.com/cdn-cgi/access/callback
```

Check the team name spelling, that it starts with `https://`, and that there is no trailing slash or stray space. The **Authorized JavaScript origin** should be `https://YOUR-TEAM.cloudflareaccess.com`. Fix it in the Google Cloud console ([guide 03, Step 2a](03-cloudflare-access.md#step-2-set-up-google-sign-in)); changes can take a few minutes to apply.

### Google shows `Error 401: deleted_client`

The OAuth client was deleted, or has expired, in Google. Create a new one and enter its Client ID and secret again in Cloudflare (Step 2a and 2b of the same guide).

### Google says "access blocked", "app not verified" or `access_denied`

While the OAuth consent screen is in **Testing**, Google lets only listed **test users** sign in. Add that person's Google address as a test user in the consent screen's **Audience** settings, or publish the app. This is Google's behaviour, and its menus and wording change, so follow what Google shows.

### I signed in with Google, but Access says I am not allowed

Google accepted you; the **Access policy** did not. In order of likelihood:

1. **Wrong Google account.** If a browser is signed in to several Google accounts, it may pick the one that is not on your list. Try a private window and choose the account explicitly.
2. **The address is not on the `Approved people` policy**, or is written differently (an alias, or a different Google account). Use the account's main address.
3. **The policy is on the wrong app.** It belongs on App 1, the people app, not the card app.
4. To see exactly which email Access received, open **Zero Trust**, then **Logs**, then **Access authentication logs**.

### The Test button in the identity providers list fails

Check that the Google **Client ID** went into Cloudflare's **App ID** field and the **Client secret** into **Client Secret**, with no spaces before or after, and that you chose **Google** rather than "Google Workspace".

### I can sign in to App 1, but I want it to ask me every time

That is the **session duration** on App 1. Shorten it in the application's settings.

---

## What the app shows

### A purchase is in the wrong category

Use the **⇄** control on that entry to move it. To make the correction automatic next time, add a **merchant rule** in **Setup**. Rules apply to new card spend only. See [05-how-spend-is-allocated.md](05-how-spend-is-allocated.md#2-merchant-rules).

### A purchase is missing entirely

It may be a category that is deliberately not tracked (groceries, fuel, department stores), in which case the card log says `Not tracked`. Add a merchant rule for that merchant, or log it by hand on the **Log** tab.

### A foreign purchase shows `EUR 840.50 · set R`

That is expected. Tap it and enter the rand amount from your statement. Until you do, it counts as R0.

### My balance changed on one phone but not another

Cloudflare documents KV as eventually consistent: a change can take up to about a minute to be visible everywhere. Refresh after a short wait.

### Something I saved vanished

State is one JSON document, written last-writer-wins. Two writes at the same instant (for example a card report landing while you save in the app) can lose one. Daily snapshots exist for 45 days, so you can recover from a recent snapshot ([02-cloudflare-account-and-worker.md](02-cloudflare-account-and-worker.md#backups)).

### The month is wrong in the first hours of the 1st

The Worker uses South African time (UTC+2). If you are in another timezone, see [08-customising.md](08-customising.md#timezone).

---

## Deploying

### `wrangler deploy` fails mentioning the KV namespace

You have not replaced `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` in `wrangler.toml`. Run `npx wrangler kv namespace create STATE` and paste the id.

### Wrangler complains about the Node version

Wrangler 4 needs Node.js **22 or newer**. Check `node --version`.

### `wrangler secret put` says there is no such Worker

Deploy first (`npx wrangler deploy`), then set secrets. Or let Wrangler create the Worker when it offers to.

### I changed the Worker name and now nothing works

The name is part of the address. A new name means a new `workers.dev` hostname, so update **both** Access applications' hostnames and the card's `workerUrl`.

---

## Backups

### `backup.json` just says "Value not found"

Two causes, and you can tell them apart:

1. **You left off `--remote`.** In Wrangler 4, `wrangler kv key` commands use local storage on your own computer by default, which is empty. Add `--remote`. See [the backup steps](02-cloudflare-account-and-worker.md#backups).
2. **There is genuinely nothing saved yet.** Run `npx wrangler kv key list --namespace-id=YOUR_KV_NAMESPACE_ID --remote`. If `dining-state` is not listed, nothing has been written yet; the key is created by the first save. Log an entry in the app and try again.

Wrangler prints this message as normal output and exits successfully, so your backup file will contain the message instead of data. Always validate the file as shown in the backup guide.

---

## The deploy script

### `Missing environment variable(s)`

Set `INVESTEC_CLIENT_ID`, `INVESTEC_CLIENT_SECRET` and `INVESTEC_API_KEY` in your shell (`export`). The script does not accept them as arguments, on purpose.

### `HTTP 401 ... check your credentials`

The client id, secret or API key is wrong, or the API key was not created with the **`cards`** scope.

### `HTTP 403`

The credentials are valid but not permitted for that card, or the card is not programmable.

### `HTTP 429`

Too many requests. Wait a moment and retry.

### `env-push` refuses to run

It will not push a file containing the word `REPLACE`, an empty value, a non-string value, or invalid JSON. Fix the file it names.

### Output includes `[number]`

That is the `logs` and `simulate` commands masking long digit runs (account numbers, card ids). Use `--raw` only for your own eyes.

---

## Still stuck?

Open an issue with: what you did, what you expected, what happened, and the relevant **masked** log lines. Say which step of which guide you were on. **Do not** include secrets, `env.json`, your real `workers.dev` address or team name, or unmasked account numbers.
