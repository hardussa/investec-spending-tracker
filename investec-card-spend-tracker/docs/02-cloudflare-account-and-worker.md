# 02. Create your Cloudflare account and deploy the Worker

This guide takes you from nothing to a deployed Worker. Afterwards the Worker is live but **locked**: it refuses to show anything until you finish [03. Cloudflare Access](03-cloudflare-access.md). That is deliberate.

**Time:** about 20 minutes.
**You will not need:** a domain name, a credit card for Workers, or any prior Cloudflare experience.

> Cloudflare's dashboard changes from time to time. If a button is labelled slightly differently from what is written here, look for the closest match, and use the linked Cloudflare documentation as the source of truth.

---

## Before you start

You need:

- A computer with a terminal (macOS Terminal, Linux, or on Windows **Git Bash** or **WSL**).
- **Node.js 22 or newer.** Check with `node --version`. Wrangler, Cloudflare's command-line tool, requires Node 22+. Install the current LTS release from [nodejs.org](https://nodejs.org/), ideally through a version manager such as [nvm](https://github.com/nvm-sh/nvm) or [Volta](https://volta.sh/) to avoid permission problems.
- **Git**, to download this project.
- An email address you can receive mail at.
- A password manager. You will generate several secrets and should store each one properly.

---

## Step 1: Create a Cloudflare account

1. Go to **<https://dash.cloudflare.com/sign-up>**.
2. Enter your email address and choose a strong, unique password.
3. Cloudflare sends a verification email. Open it and confirm your address.
4. **Turn on two-factor authentication** in your profile's security settings. Cloudflare recommends this before you set up Zero Trust, and this account will guard access to your spending data.

**Checkpoint:** you can log in to the dashboard at <https://dash.cloudflare.com/>.

You do **not** need to add a website or buy a domain. Every Worker gets a free address on `workers.dev`.

---

## Step 2: Get the code

```bash
git clone https://github.com/YOUR-USERNAME/investec-card-spend-tracker.git
cd investec-card-spend-tracker
npm install
```

Replace the URL with the address of the repository you are using.

Run the tests once to confirm your machine is set up correctly. They need no network access or accounts:

```bash
npm test
```

**Checkpoint:** the last line says `All JavaScript test files passed`.

---

## Step 3: Log in to Cloudflare from the command line

```bash
npx wrangler login
```

A browser window opens asking you to authorise Wrangler to use your account. Approve it, then return to the terminal.

**Checkpoint:** `npx wrangler whoami` prints your account.

> **Privacy note:** Wrangler sends anonymous usage telemetry to Cloudflare by default. If you would rather it did not, run `npx wrangler telemetry disable`.

---

## Step 4: Create the storage (a KV namespace)

All of your data lives in a single Cloudflare KV namespace called `STATE`.

```bash
npx wrangler kv namespace create STATE
```

Wrangler prints a block that includes an `id`, something like:

```
[[kv_namespaces]]
binding = "STATE"
id = "0123456789abcdef0123456789abcdef"
```

Open **`wrangler.toml`** and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id. Keep `binding = "STATE"` exactly as it is: the code looks for that name.

The namespace id is an identifier, not a secret, but it is specific to your account, so avoid committing your edited `wrangler.toml` to a public fork.

> If you forget this step, `wrangler deploy` fails with a clear error. The placeholder is deliberately invalid.

---

## Step 5: Choose your Worker's name

In `wrangler.toml`, the `name` becomes the first part of your address:

```
https://<name>.<your-account-subdomain>.workers.dev
```

The default is `spend-tracker`. Use letters, digits and dashes only, no more than 63 characters, not starting or ending with a dash. Pick something that is not easy to guess; the Access setup protects you either way.

---

## Step 6: Deploy

```bash
npx wrangler deploy
```

If this is your first Worker, Wrangler may ask you to **register a `workers.dev` subdomain**. Choose one. You can change it later in the dashboard under **Workers & Pages** (next to "Your subdomain"). Changing it changes your Worker's address, which you would then need to update in Cloudflare Access and in the card's `env.json`.

When it finishes, Wrangler prints your Worker's address. Write it down. The rest of the guides call it **`YOUR-HOST`**, for example `spend-tracker.your-subdomain.workers.dev` (no `https://`).

**Checkpoint, and an important one.** Open `https://YOUR-HOST/` in a browser. You should see a plain page that says **"Access is not configured on this Worker. Set ACCESS_TEAM and ACCESS_AUD as Worker secrets"**, and no data. That is the correct, safe state:

| Request | Why it is safe right now |
| --- | --- |
| `GET /` | Serves only the empty page. It contains none of your data. |
| `/api/state` and the other app routes | Return **503** until the Access secrets are set. The Worker fails closed. |
| `POST /api/card` | Returns **401** until you set `CARD_KEY`. |

---

## Step 6b: Generate and set the card key

The card key is a shared secret that the card code sends with every report. Generate a long random one. This works on any system that has Node installed:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It prints 64 random hex characters. **Copy it into your password manager now**; you need the same value again when you configure the card.

Then store it as a Worker secret:

```bash
npx wrangler secret put CARD_KEY
```

Paste the value when prompted. Wrangler stores it encrypted in Cloudflare. It is **not** written to any file in this project.

> Do not type secrets directly into a command line (`echo`, or `--value`). They end up in your shell history. The interactive prompt does not.

---

## Step 7: Continue to Cloudflare Access

Your Worker is deployed but locked. Now set up the front door: [03. Cloudflare Access](03-cloudflare-access.md).

That guide ends with you setting the remaining three secrets (`ACCESS_TEAM`, `ACCESS_AUD`, `ALLOWED_EMAILS`).

---

## Updating later

After changing code or pulling updates:

```bash
npm test
npm run deploy
```

Secrets and your KV data are untouched by a deploy.

To watch live requests and errors while testing:

```bash
npm run logs
```

---

## Backups

The Worker writes a daily snapshot of your data under keys named `snap:YYYY-MM-DD`, and keeps each for 45 days. These live in the same KV namespace as your live data, which is stored under the key `dining-state`.

> **Always add `--remote`.** In Wrangler 4, the `wrangler kv key` commands read and write **local storage on your own computer** unless you pass `--remote`. Forget it and a backup says `Value not found` (your real data is in Cloudflare, not on your computer), while a restore *appears* to succeed and changes nothing real.

In the commands below, replace `YOUR_KV_NAMESPACE_ID` with the `id` in your `wrangler.toml`, and make sure you are logged in (`npx wrangler login`).

### 1. Check there is something to back up

```bash
npx wrangler kv key list --namespace-id=YOUR_KV_NAMESPACE_ID --remote
```

You should see `dining-state`, and after a day or more some `snap:...` entries. **The key is only created the first time something is saved**, so on a brand-new install the list is empty. Log an entry in the app (or run a simulation) and list again.

### 2. Back up

```bash
npx wrangler kv key get dining-state --namespace-id=YOUR_KV_NAMESPACE_ID --remote > backup.json
```

Do not add `--text`: it appends a newline. Without it the file is exactly what is stored, byte for byte, including accented characters.

### 3. Check the file before you trust it

If the key does not exist, Wrangler prints `Value not found` to normal output **and still exits successfully**. So the file can quietly contain that message instead of your data. Confirm it is real:

```bash
python3 -c "import json; json.load(open('backup.json')); print('backup is valid JSON')"
```

(On Windows or if `python3` is not found, use `python`.) A good backup starts with `{`.

Treat `backup.json` as private: it lists your merchants and amounts. **Do not save it inside the repository folder.**

### Restoring

Restoring **overwrites everything**, so take a fresh backup first.

```bash
npx wrangler kv key put dining-state --path backup.json --namespace-id=YOUR_KV_NAMESPACE_ID --remote
```

To go back to a daily snapshot, fetch it the same way and then put it into `dining-state`:

```bash
npx wrangler kv key get snap:2026-10-18 --namespace-id=YOUR_KV_NAMESPACE_ID --remote > snapshot.json
npx wrangler kv key put dining-state --path snapshot.json --namespace-id=YOUR_KV_NAMESPACE_ID --remote
```

Without `--remote`, the restore writes to local storage and tells you it succeeded. After restoring, open the app and check your data.

---

## Removing everything

If you want to stop using this and clean up:

1. In Cloudflare, **Workers & Pages**, delete the Worker.
2. Find **KV** in the dashboard sidebar (its exact location varies) and delete the `STATE` namespace. This destroys your data.
3. In **Zero Trust**, **Access controls**, **Applications**, delete both Access applications, and delete the service token under **Service credentials**.
4. In Investec, remove or replace the card code and clear its environment variables.
5. Revoke any Investec API key you created for the deploy script.

---

## Next

[03. Cloudflare Access: email sign-in, service token and the two Access apps](03-cloudflare-access.md)
