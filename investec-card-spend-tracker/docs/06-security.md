# 06. Security, privacy and what to do if something leaks

This project handles your spending data, so the security model is documented in full, including its limits. Read the [limits](#what-this-does-not-protect-against) as carefully as the protections.

---

## The layers

| # | Layer | What it stops |
| --- | --- | --- |
| 1 | **Cloudflare Access, people app.** Google sign-in, Allow policy listing specific Google accounts. | Anyone who is not on your list reaching the app at all. |
| 2 | **The Worker verifies the Access token itself.** | A mistake in layer 1 (a loosened policy, a misrouted hostname) becoming open access. |
| 3 | **`ALLOWED_EMAILS`.** A second, independent allow-list inside the Worker. | The same mistake, from a different direction. |
| 4 | **Cloudflare Access, card app.** Service Auth with one service token, scoped to `/api/card`. | Anyone without the token reaching the card endpoint. |
| 5 | **Shared secret `CARD_KEY`**, compared in constant time. | A leaked service token alone being enough to write data. |
| 6 | **Strict page and response hardening.** | Script injection, framing, third-party calls. |
| 7 | **Input limits and caps.** | A bug or attacker growing your data without bound. |

An attacker would need to defeat several of these at once. In particular, the card endpoint needs **both** the service token and the shared secret, held in two different places.

---

## What the Worker verifies on every request to `/api/*`

For every app route, `verifyAccess` in `src/worker.js` checks, in order:

1. A token is present, in the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie.
2. It has three parts and its header says **RS256**. Tokens that claim `none`, `HS256` or anything else are rejected, which closes the classic "algorithm confusion" attack.
3. Its key id matches one of the signing keys Cloudflare publishes for **your** team. The keys are fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and cached for an hour. If they cannot be fetched, requests are **refused**, not allowed.
4. The **signature verifies** against that key.
5. It has an expiry and has not expired. A not-before time is honoured with 60 seconds of clock tolerance.
6. The **issuer** is exactly your team's Access domain.
7. The **audience** includes your application's AUD tag, so a token from some *other* Access app, even in your own account, is refused.
8. **It carries an email address.** (See the box below.)
9. If `ALLOWED_EMAILS` is set, the email is on it (case and spaces ignored).

Missing `ACCESS_TEAM` or `ACCESS_AUD` returns **503** with a setup hint. It never falls back to open.

> **Why step 8 exists.** When a *service token* authenticates, Cloudflare issues a perfectly valid, correctly signed token with the app's audience tag but **no email** (its `sub` is empty). Without step 8, a deployment that left `ALLOWED_EMAILS` empty would have accepted that token as a signed-in person. The test suite includes a service-token-shaped token and asserts it is refused for both reads and writes, and removing the check makes those tests fail.

---

## The card endpoint

`POST /api/card` does not use the Access token. It requires the `x-card-key` header to equal the `CARD_KEY` secret. The comparison is constant-time. If `CARD_KEY` is not set, nothing matches (not even an empty header). A person's signed-in session does not authorise it, and the card key does not authorise any app route.

Both credentials must be present: the service token gets a request through Cloudflare Access, and the shared secret gets it past the Worker.

---

## The page and responses

- **Content-Security-Policy:** `default-src 'none'`; scripts and styles only by a **fresh per-request nonce**; `connect-src 'self'`; `frame-ancestors 'none'`; no `unsafe-inline` or `unsafe-eval`.
- Also set: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`, and a restrictive `Permissions-Policy`.
- **Nothing is loaded from outside the Worker**: no CDN, fonts, analytics or trackers. A test fails if the page ever references a third-party URL.
- **Names are escaped before display.** Merchant names come from outside your control; a test feeds in `<img onerror>` and `<script>` payloads and asserts nothing is injected.
- The HTML itself contains **no user data**. Data arrives only through authenticated API calls.

---

## What leaves Investec, and what is stored

After each approved transaction the card code sends: **merchant code, merchant name, amount, currency, and a cardholder label you choose.**

It does **not** send the card number, account number, card id, balance or any personal details, and it deliberately logs only those same five fields rather than the whole transaction object.

Stored in your KV namespace: those fields, plus the date, a random id, and whether the entry was `card` or `manual`. Signed-in people are identified in the log by the part of their email before the `@`.

**Be aware of what this data is.** A list of merchants and amounts is a fairly detailed picture of someone's life. It lives in your Cloudflare account, under Cloudflare's terms and security. If you share your Cloudflare login or your Worker, you share this.

---

## Secrets inventory

| Secret | Created | Stored in | Who can see it |
| --- | --- | --- | --- |
| `CARD_KEY` | You, with a random generator | Worker secret **and** the card's `env.json` as `cardKey` | Anyone with your Cloudflare account, or access to your Investec developer area |
| `cfAccessClientId` / `cfAccessClientSecret` | Cloudflare (shown once) | The card's `env.json` | Anyone with access to your Investec developer area |
| `ACCESS_TEAM`, `ACCESS_AUD` | Cloudflare | Worker secrets | Not secret in themselves (identifiers); treated as private config |
| `ALLOWED_EMAILS` | You | Worker secret | Anyone with your Cloudflare account |
| Google OAuth client ID and secret | You, in the Google Cloud console | Cloudflare's Google identity-provider settings, and your password manager | Anyone with your Cloudflare account or your Google Cloud project |
| Investec client id, secret, API key | Investec | Your shell session (script only) | You. They are never written to disk by this project. |
| Cloudflare account login | You | Your password manager | You |

**Never in this repository:** every secret above. `.gitignore` excludes `card/env.json`, `.env*`, `.dev.vars*`, key files and `node_modules`. `wrangler.toml` contains only a KV id placeholder. The Worker's secrets are set with `wrangler secret put`, which stores them in Cloudflare and never on disk.

---

## What this does NOT protect against

Honest limits:

- **Your Google accounts.** Sign-in is "whoever can sign in to an allowed Google account". If one of those accounts is compromised, so is the app. Turn on Google's **2-Step Verification** for every allowed account, use strong unique passwords, and keep the policy list short. Note that the Google sign-in step itself is open to any Google account (the consent screen is "External"); it is the Access policy and `ALLOWED_EMAILS` that turn everyone else away.
- **Your Cloudflare account.** Whoever controls it controls the Worker, the secrets and the data. Turn on two-factor authentication.
- **Your Investec developer area.** The card's environment variables, including the shared secret and service-token secret, are visible to anyone who can open the IDE for that card. Do not screenshot it.
- **A lost, unlocked phone with an active session.** A signed-in browser keeps working until the Access session expires. Choose a session length you are comfortable with, and revoke sessions from Cloudflare if a phone is lost.
- **Lost or silently lost data.** State is one JSON document, written last-writer-wins. Two writes in the same instant can lose one, and KV is eventually consistent. The 45-day snapshots help with bad edits, not with every possible loss.
- **A tracker is not a ledger.** Entries can be edited, moved and deleted by anyone signed in. Your bank statement remains the record.
- **Cloudflare or Investec themselves.** You are trusting both platforms with this data.
- **Other addresses for the same Worker.** Preview and version URLs live on different hostnames that a hostname-based Access app does not cover. They expose nothing (see below), but you may prefer to protect them too.

Why the other addresses are harmless: the Worker re-verifies the Access token for every `/api/*` route, so those addresses return 401. The card endpoint on them would still need the shared secret. Only the empty HTML shell is served without a token.

---

## If something leaks

| What leaked | What to do |
| --- | --- |
| **`CARD_KEY`** | Generate a new one. `npx wrangler secret put CARD_KEY`. Update the card's `env.json` and push it. The service token still protects the endpoint in the meantime. |
| **Service token secret** | Create a new service token. Point App 2's policy at it. Update the card's `env.json`. Delete the old token. The shared secret still protects the endpoint in the meantime. |
| **Both of the above** | Do both, immediately. Then look through your entries for anything you do not recognise, and use a snapshot if you need to roll back. |
| **An allowed Google account** | Remove that address from the `Approved people` policy **and** from `ALLOWED_EMAILS`. Revoke sessions in Cloudflare. Secure or recover the Google account. Review your data. |
| **Google OAuth client secret** | In the Google Cloud console, create a new secret (or a new OAuth client), enter it in Cloudflare's Google identity-provider settings, and delete the old one. |
| **Investec API credentials** | Revoke or regenerate the API key in Investec Online. Ask Investec how to rotate a client secret. |
| **Cloudflare login** | Change the password, enable two-factor authentication, review the account's tokens and sessions, then rotate every secret in this table. |
| **A secret committed to Git** | Treat it as **public and compromised**, even if you delete the commit. Rotate it first. Removing it from history is secondary. |

---

## Sharing logs, screenshots and questions safely

People will ask for logs when helping you. Before you post anything:

- **Execution logs** from Investec include `accountNumber` and the card `id` if your own code logs the whole transaction. This project's code does not, and `scripts/investec_card.py logs` masks long numbers by default. Still, read before you paste.
- **Never** share `card/env.json`, a screenshot of the IDE's `env.json` tab, the output of `wrangler secret` commands, curl commands containing real headers, or `backup.json`.
- Replace your real `workers.dev` address with `YOUR-HOST` and your team name with `YOUR-TEAM`.
- Your merchants and amounts are personal data. Redact them if they identify you.

---

## Keeping secrets out of your own Git repository

Before you push a fork:

```bash
python scripts/scan_for_secrets.py
```

It scans every file for email addresses (other than the reserved `example.com`, `example.org` and `example.net`), JWT-shaped strings, long hexadecimal strings (Cloudflare account ids, AUD tags and keys look like this), private-key blocks, and real-looking `workers.dev` addresses. You can add your own identifiers to check for, without writing them to disk:

```bash
python scripts/scan_for_secrets.py --deny your-subdomain --deny your-team-name
```

Also turn on **secret scanning and push protection** in your GitHub repository's security settings. A clean scan is a safety net, not a guarantee. Read your diff.

---

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Please report privately, not in a public issue.

---

## A note on terms of use

This project makes outbound calls from Investec's programmable card platform to a server you control. Read Investec's programmable banking terms and developer documentation, Cloudflare's terms for Workers, Access and Zero Trust, and Google's terms for the Google Cloud console and Google sign-in, and make sure your use complies. This project's authors cannot advise on that.
