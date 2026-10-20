# 04. Put the code on your Investec card

By the end of this guide your card reports every approved transaction to your Worker, and you will have seen it work in the simulator and with one real purchase.

**Time:** 20 to 30 minutes.
**Starts from:** a deployed, protected Worker and a working card door (guide 03, Step 9 passed).

> Investec's website and IDE change over time. Menu names below follow Investec's developer site at the time of writing; if something differs, follow what is on screen and Investec's own documentation at <https://developer.investec.com/>.

---

## Read this first: a naming trap

Two different things are both called a "card key":

| Name | What it is | Where it is used |
| --- | --- | --- |
| **`CardKey`** (Investec) | Investec's identifier for one of your cards, such as `1010101`. Returned by the API's "Get Cards". | In API URLs, and with the deploy script's `--card-key`. |
| **`cardKey`** (in `env.json`) | **Your shared secret**: the same random value you stored as the Worker secret `CARD_KEY`. | Sent by the card code in the `x-card-key` header. |

They are unrelated. If you put Investec's card identifier into `env.json`'s `cardKey`, the Worker answers **401**, and the card log says `worker returned 401`.

---

## What you need

- An Investec account that is **enrolled for Investec Developer**, with at least one **programmable card**. Cards that are not programmable cannot run code.
- The five values for the card's `env.json` (below).
- *For Route B only:* Investec API credentials, a **client ID**, a **client secret**, and an **API key (`x-api-key`) with the `cards` scope**.

### The card's environment variables (`env.json`)

Copy `card/env.example.json` to `card/env.json` (this file is git-ignored) and fill in every value:

| Variable | What to put |
| --- | --- |
| `workerUrl` | `https://YOUR-HOST` with **no trailing slash and no path**, for example `https://spend-tracker.your-subdomain.workers.dev`. |
| `cardKey` | The random string you set as `CARD_KEY` in guide 02. **Not** Investec's CardKey. |
| `cardHolder` | A short label shown next to each entry, for example a first name. |
| `cfAccessClientId` | The service token's **Client ID** (guide 03, Step 7). |
| `cfAccessClientSecret` | The service token's **Client Secret**. |

> `card/env.json` contains live secrets. It is already listed in `.gitignore`. **Never commit it, screenshot it, or paste it into a forum or chat.**

---

## Route A: paste into Investec's IDE

No API credentials needed.

1. Sign in to **Investec Online**.
2. Open **Manage**, then **Investec Developer**. (Business and corporate profiles reach the same area through an "Investec Developer" tile.)
3. On the **Programmable Card IDE** tile, choose **manage code**.
4. Select your programmable card.
5. In the **`main.js`** editor, replace the contents with the contents of **`card/main.js`** from this project.
6. In the **`env.json`** editor, replace the contents with your filled-in `card/env.json`.
7. Use the IDE's **simulate** feature to run a test transaction (see [Test it](#test-it)).
8. Save the code and publish it so it runs on real transactions. Use the IDE's own buttons; their exact names are Investec's to define.

**Important:** simulating runs the code you are looking at, but **real transactions run only the _published_ code.** A common mistake is to save and simulate successfully but never publish.

---

## Route B: the command-line script

`scripts/investec_card.py` does the same job from a terminal and adds log reading. It needs Python 3.7 or newer.

### B1. Get API credentials

In Investec Online, open **Manage**, then **Investec Developer**. You can view your **client ID** and **client secret** there. Select **Create new API key**, give it an alias, and make sure it is created with the **`cards`** scope. The key is your `x-api-key`.

Treat all three values like passwords.

### B2. Install and load credentials safely

```bash
pip install -r scripts/requirements.txt

# Paste each value and press Enter. Nothing is echoed, and nothing enters shell history.
read -rs INVESTEC_CLIENT_ID;     echo
read -rs INVESTEC_CLIENT_SECRET; echo
read -rs INVESTEC_API_KEY;       echo
export INVESTEC_CLIENT_ID INVESTEC_CLIENT_SECRET INVESTEC_API_KEY
```

The script accepts credentials **only** from environment variables, deliberately, so they never appear in shell history or process listings. It never prints them.

### B3. Find your card

```bash
python scripts/investec_card.py cards
```

Example output (values made up):

```
CardKey        Card number (masked)   Status       Programmable  Virtual
1010101        402167XXXXXX1111       Active       yes           no
1020202        402167XXXXXX2222       Dormant      no            yes
```

Use the `CardKey` of a **Programmable = yes** card. The command deliberately does **not** print your account number, account id or the name embossed on the card, so the output is safe to share when asking for help.

```bash
export INVESTEC_CARD_KEY=1010101        # or pass --card-key 1010101 to each command
```

### B4. Push the environment variables

```bash
cp card/env.example.json card/env.json      # then edit card/env.json and fill it in

python scripts/investec_card.py env-push            # dry run: lists names, changes nothing
python scripts/investec_card.py env-push --yes      # applies it
```

> **`env-push` replaces _all_ of the card's variables.** Investec's API cannot patch individual variables. Anything on the card that is not in your `env.json` is deleted. The dry run lists the names so you can see what will be replaced. It never prints values, and it refuses to run while any value still contains the word `REPLACE`.

### B5. Deploy the code

```bash
python scripts/investec_card.py deploy
```

This saves `card/main.js` to the card, **publishes** it, then fetches the published copy and confirms it matches. Use `--no-publish` to save a draft without making it live.

### B6. Read what is on the card

```bash
python scripts/investec_card.py show                # the saved draft
python scripts/investec_card.py show --published    # what real transactions will run
```

---

## Test it

Test in this order. Each step has a visible result in the app.

### 1. Simulate a restaurant meal

Route B:

```bash
python scripts/investec_card.py simulate --mcc 5812 --amount 125.50 --merchant "Test Cafe"
```

Route A: use the IDE simulator with merchant code `5812`, amount 12550 cents, currency `zar`.

You should see two executions, a `before_transaction` that is **approved**, and an `after_transaction` with log lines ending something like:

```
Logged under dining (matched by mcc). R2875 left.
```

Open the app. **Test Cafe** should be on the **This month** and **Log** tabs. Delete it afterwards.

> **A simulation is not isolated.** The simulator runs your code with the environment variables saved on the card, so it calls your **real** Worker and creates a **real** test entry. Always delete test entries afterwards.

### 2. Simulate a hotel abroad (foreign currency)

```bash
python scripts/investec_card.py simulate --mcc 7011 --currency eur --amount 840.50 --merchant "Test Hotel"
```

In the app, the **Holiday** tab shows a held entry: **`EUR 840.50 · set R`**. It counts as R0 until you tap it and type what it cost in rand. This is deliberate. See [05-how-spend-is-allocated.md](05-how-spend-is-allocated.md).

### 3. Simulate something that should be ignored

```bash
python scripts/investec_card.py simulate --mcc 5411 --amount 450 --merchant "Test Supermarket"
```

The log says `Not tracked: no category for merchant code 5411.` and nothing appears in the app.

### 4. A real purchase

Make a small real purchase at a restaurant. Within seconds it should appear in the app. Then check Investec's record:

```bash
python scripts/investec_card.py logs --limit 4
```

The newest executions should show **`(live)`** rather than `(sandbox)`. If your real purchase never shows up but simulations do, see "Simulates fine, real purchases do not appear" in [07-troubleshooting.md](07-troubleshooting.md).

---

## Reading logs safely

```bash
python scripts/investec_card.py logs --limit 5
```

Investec's raw transaction object includes your **account number** and **card id**. The `logs` and `simulate` commands mask any run of 8 or more digits by default, so output is safe to paste into a forum. This project's card code also deliberately logs only the merchant code, name, amount and currency, never the whole object.

Use `--raw` only for your own eyes. **Before pasting logs anywhere public, read them.**

---

## What the card code does and does not do

- **`beforeTransaction`** always approves, and makes no network call. It cannot slow down or block a purchase.
- **`afterTransaction`** reports the transaction to your Worker, with up to 15 seconds available, and then logs what the Worker said.
- **`afterDecline`** only logs. If a purchase is declined it was the bank that declined it (funds, limits, card status), never this code.
- If your Worker is down or rejects a report, the failure is logged and the purchase is unaffected. The entry is simply not recorded; log it by hand in the app.

---

## Stopping

To stop reporting, deploy a minimal pass-through, or clear the code in the IDE. For example, save this as `empty.js` and run `python scripts/investec_card.py deploy --file empty.js`:

```js
const beforeTransaction = async () => true;
const afterTransaction = async () => {};
```

You can also remove the card's environment variables in the IDE.

---

## Next

- [05. How spend is allocated](05-how-spend-is-allocated.md), to understand and tune the categories.
- [07. Troubleshooting](07-troubleshooting.md), if anything above did not behave.
