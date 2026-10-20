# Contributing

Thanks for helping. This is a small project with a strong bias toward being safe and easy to audit, so a few rules matter more than usual.

## Ground rules

1. **Never commit a secret, a personal identifier or real data.** That includes API keys, tokens, `card/env.json`, real email addresses, real `workers.dev` addresses or team names, account numbers, card numbers, and real transaction logs. Use `example.com` addresses and obvious placeholders such as `YOUR-HOST`.
2. **Run the scanner before every push:** `python scripts/scan_for_secrets.py`. Add `--deny` terms for your own identifiers.
3. **Security tests are not negotiable.** If a change forces you to edit a test in `test/security.test.cjs` to make it pass, say why in the pull request. Weakening a check to get green is not a fix.
4. **No runtime dependencies in the Worker.** `src/worker.js` is one self-contained file on purpose, so it can be read in an evening. Dev dependencies (Wrangler, jsdom) are fine.
5. **Nothing loaded from a third party** by the page. A test fails if it is.
6. **The card code must never decline a transaction.** A test enforces it.
7. **Keep the docs true.** If you change behaviour, change the guide that describes it. If you add a claim about Cloudflare or Investec, check it against their current documentation and link it.

## Setting up

```bash
git clone <your fork>
cd investec-card-spend-tracker
npm install
npm test
python -m unittest discover -s test -p "test_*.py"
python scripts/scan_for_secrets.py
```

You need Node.js 22 or newer. Python 3.7 or newer is needed for the script and its tests. No accounts, credentials or network access are needed to run any test.

## What a good change looks like

- **Small and focused**, with a test that fails without the change.
- **Python code stays 3.7-compatible.** CI checks the minimum version with `vermin`. No walrus operator, no `X | Y` unions, no f-string `=`.
- **Errors explain themselves** and never print credentials.
- **Docs are in plain English**, with a checkpoint after each step that tells the reader how to know it worked.

## Reporting bugs

Open an issue with what you did, what you expected, what happened, and which step of which guide you were on. Include **masked** log lines only. Read [docs/06-security.md](docs/06-security.md#sharing-logs-screenshots-and-questions-safely) first.

To report a security problem, follow [SECURITY.md](SECURITY.md) instead. Do not use a public issue.

## Scope

Good fits: more accurate merchant-code coverage, better foreign-currency handling, accessibility, clearer docs, more tests, support for other timezones or currencies.

Probably not: features that add third-party services, user accounts, or anything that sends your data somewhere other than your own Worker.
