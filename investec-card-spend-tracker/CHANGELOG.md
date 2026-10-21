# Changelog

## 1.0.0

First public release.

### Features

- Card spend is allocated to **eating out**, **holiday** or **clothing** by merchant rule, then merchant category code. Other spend is ignored.
- Eating-out budget with monthly roll-over, a weekend pot and splurge checks.
- Holiday and clothing pots that accrue monthly without resetting at year end, with rate changes that never rewrite history.
- Foreign-currency card spend is held as pending until you confirm the rand amount.
- Move any entry between categories; turn corrections into merchant rules.
- Duplicate detection across all categories.
- Card code is **tracking only**: it never declines a transaction.
- Sign-in with **Google** (a Gmail or any Google account) through Cloudflare Access, with an allow-list of addresses. The Worker verifies the Access token itself, so any identity provider that supplies an email works too; emailed one-time codes are documented as an alternative.
- Optional Python 3.7+ command-line tool to push environment variables, deploy, simulate and read logs, with credentials from the environment only and long numbers masked in output.
- `scripts/scan_for_secrets.py` to check a fork before publishing.
- Step-by-step documentation, including creating the Cloudflare account and setting up Access.

### Security

- The Worker requires an **email claim** in Access tokens. Cloudflare issues valid tokens for service tokens that carry no email; without this check, a deployment with an empty `ALLOWED_EMAILS` would have accepted such a token as a signed-in person. Covered by tests that fail if the check is removed.
- Algorithm-confusion (`none`, `HS256`), forged-signature, wrong-audience, wrong-issuer and expired-token cases are all covered by tests.
- Strict Content-Security-Policy with per-request nonces; the page loads nothing from third parties.
- The card endpoint requires both a Cloudflare Access service token and a shared secret, compared in constant time.
