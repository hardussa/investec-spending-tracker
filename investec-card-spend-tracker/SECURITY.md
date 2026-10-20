# Security policy

This project handles personal spending data and is protected by Cloudflare Access plus its own token checks. Security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please report privately, not in a public issue.**

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. That creates a private conversation with the maintainers.

If that option is not available on the repository you are looking at, open a public issue that says only that you have a security report and asks for a private channel. **Do not include any details of the vulnerability in that issue.**

Please include:

- what you found and where (file, function or route),
- the impact as you understand it,
- steps to reproduce, ideally as a failing test in the style of `test/security.test.cjs`,
- whether you believe it is already being exploited.

Please do **not** include real secrets, real account numbers or real Cloudflare or Investec identifiers in a report. Use made-up values.

## What to expect

This is a community project maintained in spare time. There is no guaranteed response time, but reports are triaged as soon as a maintainer can look at them, and a confirmed issue is fixed and disclosed in the changelog with credit to the reporter if they want it.

## Scope

In scope:

- Authentication or authorisation bypasses in `src/worker.js`, including Cloudflare Access token handling, the allow-list, and the card key check.
- Anything that lets one caller read, write or delete data they should not.
- Script injection, header or content-policy weaknesses in the served page.
- Secrets or personal identifiers appearing in the repository, the card code, the scripts or their output.
- Problems in `scripts/investec_card.py` that could leak credentials.

Out of scope:

- Vulnerabilities in Cloudflare, Investec or other third-party services themselves. Please report those to the vendor.
- Issues that require control of your Cloudflare account, your Investec developer area or an allowed email account. Those are listed as known limits in [docs/06-security.md](docs/06-security.md).
- Reports about a deployment you misconfigured, where the documented setup was not followed.

## Supported versions

Only the latest release receives fixes.

## If you think your own deployment is exposed

See "If something leaks" in [docs/06-security.md](docs/06-security.md#if-something-leaks) for what to rotate and in what order.
