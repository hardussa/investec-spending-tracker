#!/usr/bin/env python3
"""
Deploy and manage Investec Programmable Card code from the command line.

An alternative to pasting code into the Programmable Card IDE in Investec
Online. Works on Python 3.7 and newer. Needs one dependency:

    pip install -r scripts/requirements.txt

Credentials come from environment variables only. They are never accepted on
the command line (so they stay out of shell history) and never printed:

    INVESTEC_CLIENT_ID       your client id
    INVESTEC_CLIENT_SECRET   your client secret
    INVESTEC_API_KEY         an x-api-key created with the "cards" scope
    INVESTEC_CARD_KEY        (optional) the card to act on; or use --card-key
    INVESTEC_BASE_URL        (optional) override the API host

Commands:

    cards       list your cards so you can find the CardKey to use
    env-push    REPLACE the card's environment variables from card/env.json
    deploy      save card/main.js to the card, publish it, and verify it
    show        print the saved (or --published) code currently on the card
    simulate    run card/main.js in Investec's sandbox against a mock transaction
    logs        show recent execution logs (numbers are masked so they are safe
                to paste into a forum; use --raw to see everything)

Endpoints used (from Investec's Card API specification):

    POST /identity/v2/oauth2/token
    GET  /za/v1/cards
    POST /za/v1/cards/{cardKey}/environmentvariables
    POST /za/v1/cards/{cardKey}/code
    POST /za/v1/cards/{cardKey}/publish
    GET  /za/v1/cards/{cardKey}/code
    GET  /za/v1/cards/{cardKey}/publishedcode
    POST /za/v1/cards/{cardKey}/code/execute
    GET  /za/v1/cards/{cardKey}/code/executions
"""

import argparse
import base64
import json
import os
import re
import sys

import requests

DEFAULT_BASE_URL = "https://openapi.investec.com"
TIMEOUT_SECONDS = 30
PLACEHOLDER_MARK = "REPLACE"


class CliError(Exception):
    """A problem the user can fix. Printed without a traceback."""

    def __init__(self, message, code=1):
        Exception.__init__(self, message)
        self.code = code


def require_env(*names):
    """Read required environment variables, naming (never echoing) any missing."""
    values = {}
    missing = []
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            values[name] = value
        else:
            missing.append(name)
    if missing:
        raise CliError(
            "Missing environment variable(s): " + ", ".join(missing) + ".\n"
            "Set them in your shell for this session (do not put them in a file "
            "that is committed to git).",
            code=2,
        )
    return values


class InvestecCardApi(object):
    """A very small client for the parts of the Card API this project uses."""

    def __init__(self, client_id, client_secret, api_key, base_url=DEFAULT_BASE_URL):
        self.client_id = client_id
        self.client_secret = client_secret
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._token = None

    # -- transport ----------------------------------------------------------

    def _request(self, method, path, headers=None, **kwargs):
        url = self.base_url + path
        try:
            response = requests.request(
                method, url, headers=headers or {}, timeout=TIMEOUT_SECONDS, **kwargs
            )
        except requests.exceptions.RequestException as exc:
            # The exception text can contain the URL but never our credentials.
            raise CliError("Could not reach " + self.base_url + ": " + exc.__class__.__name__)
        if response.status_code >= 400:
            body = (response.text or "").strip().replace("\n", " ")[:300]
            hint = ""
            if response.status_code == 401:
                hint = " (check your credentials, and that the API key has the 'cards' scope)"
            elif response.status_code == 403:
                hint = " (this key or card is not permitted to do that)"
            elif response.status_code == 429:
                hint = " (too many requests; wait a moment and retry)"
            raise CliError(
                method + " " + path + " failed with HTTP " + str(response.status_code) + hint
                + (": " + body if body else "")
            )
        try:
            return response.json()
        except ValueError:
            raise CliError(method + " " + path + " returned something that was not JSON.")

    def _auth(self):
        if self._token is None:
            raw = (self.client_id + ":" + self.client_secret).encode("utf-8")
            basic = base64.b64encode(raw).decode("ascii")
            data = self._request(
                "POST",
                "/identity/v2/oauth2/token",
                headers={
                    "x-api-key": self.api_key,
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Authorization": "Basic " + basic,
                },
                data={"grant_type": "client_credentials"},
            )
            token = data.get("access_token")
            if not token:
                raise CliError("The token endpoint did not return an access_token.")
            self._token = token
        return {
            "Authorization": "Bearer " + self._token,
            "Accept": "application/json",
        }

    def _json_headers(self):
        headers = self._auth()
        headers["Content-Type"] = "application/json"
        return headers

    # -- the API calls ------------------------------------------------------

    def list_cards(self):
        data = self._request("GET", "/za/v1/cards", headers=self._auth())
        return data["data"]["cards"]

    def set_env(self, card_key, variables):
        data = self._request(
            "POST",
            "/za/v1/cards/" + card_key + "/environmentvariables",
            headers=self._json_headers(),
            data=json.dumps({"variables": variables}),
        )
        return data["data"]["result"]

    def save_code(self, card_key, code):
        data = self._request(
            "POST",
            "/za/v1/cards/" + card_key + "/code",
            headers=self._json_headers(),
            data=json.dumps({"code": code}),
        )
        return data["data"]["result"]

    def publish_code(self, card_key, code_id, code):
        data = self._request(
            "POST",
            "/za/v1/cards/" + card_key + "/publish",
            headers=self._json_headers(),
            data=json.dumps({"codeid": code_id, "code": code}),
        )
        return data["data"]["result"]

    def get_saved_code(self, card_key):
        data = self._request("GET", "/za/v1/cards/" + card_key + "/code", headers=self._auth())
        return data["data"]["result"]

    def get_published_code(self, card_key):
        data = self._request(
            "GET", "/za/v1/cards/" + card_key + "/publishedcode", headers=self._auth()
        )
        return data["data"]["result"]

    def execute(self, card_key, body):
        data = self._request(
            "POST",
            "/za/v1/cards/" + card_key + "/code/execute",
            headers=self._json_headers(),
            data=json.dumps(body),
        )
        return data["data"]["result"]

    def get_executions(self, card_key):
        data = self._request(
            "GET", "/za/v1/cards/" + card_key + "/code/executions", headers=self._auth()
        )
        return data["data"]["result"]


# -- helpers ----------------------------------------------------------------


def read_text_file(path, what):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except IOError:
        raise CliError("Cannot read " + what + " at " + path + ".")


def resolve_card_key(args):
    card_key = (args.card_key or os.environ.get("INVESTEC_CARD_KEY", "")).strip()
    if not card_key:
        raise CliError(
            "No card selected. Run the 'cards' command to find your card's CardKey, "
            "then pass --card-key or set INVESTEC_CARD_KEY.",
            code=2,
        )
    # The key goes into a URL path, so refuse anything that is not a plain token.
    if not all(ch.isalnum() or ch in "-_" for ch in card_key):
        raise CliError("That does not look like a CardKey (letters, digits, - and _ only).", code=2)
    return card_key


def build_api():
    env = require_env("INVESTEC_CLIENT_ID", "INVESTEC_CLIENT_SECRET", "INVESTEC_API_KEY")
    return InvestecCardApi(
        env["INVESTEC_CLIENT_ID"],
        env["INVESTEC_CLIENT_SECRET"],
        env["INVESTEC_API_KEY"],
        os.environ.get("INVESTEC_BASE_URL", "").strip() or DEFAULT_BASE_URL,
    )


NUMBER_RUN = re.compile(r"\b\d{8,}\b")


def mask_numbers(text, raw=False):
    """Hide long digit runs (account numbers, card ids) in log lines."""
    return text if raw else NUMBER_RUN.sub("[number]", text)


def print_executions(executions, out, raw=False):
    for ex in executions:
        approved = ex.get("authorizationApproved")
        verdict = "" if approved is None else ("  approved" if approved else "  DECLINED")
        out("--- " + str(ex.get("type")) + verdict
            + ("  (sandbox)" if ex.get("sandbox") else "  (live)")
            + "  " + str(ex.get("startedAt") or ex.get("createdAt") or ""))
        if ex.get("Error"):
            out("  ERROR: " + mask_numbers(str(ex["Error"]), raw))
        logs = ex.get("logs") or []
        if not logs:
            out("  (no log output: the code returned without calling console.log)")
        for entry in logs:
            out("  [" + str(entry.get("level", "info")) + "] "
                + mask_numbers(str(entry.get("content", "")), raw))


# -- commands ---------------------------------------------------------------


def cmd_cards(args, out):
    api = build_api()
    cards = api.list_cards()
    if not cards:
        out("No cards were returned for these credentials.")
        return 0
    # Deliberately NOT printed: account number, account id and embossed name.
    # People paste this output into forums; it should be safe to do so.
    out("{0:<14} {1:<22} {2:<12} {3:<13} {4}".format(
        "CardKey", "Card number (masked)", "Status", "Programmable", "Virtual"))
    for card in cards:
        out("{0:<14} {1:<22} {2:<12} {3:<13} {4}".format(
            str(card.get("CardKey", "")),
            str(card.get("CardNumber", "")),
            str(card.get("Status", "")),
            "yes" if card.get("IsProgrammable") else "no",
            "yes" if card.get("IsVirtualCard") else "no",
        ))
    out("")
    out("Use the CardKey with --card-key or INVESTEC_CARD_KEY.")
    out("Only cards marked Programmable = yes can run code.")
    return 0


def cmd_env_push(args, out):
    card_key = resolve_card_key(args)
    raw = read_text_file(args.file, "the environment file")
    try:
        variables = json.loads(raw)
    except ValueError:
        raise CliError(args.file + " is not valid JSON.")
    if not isinstance(variables, dict) or not variables:
        raise CliError(args.file + " must be a JSON object with at least one variable.")

    problems = []
    for name, value in variables.items():
        if not isinstance(value, str):
            problems.append(name + " must be a string")
        elif not value.strip():
            problems.append(name + " is empty")
        elif PLACEHOLDER_MARK in value:
            problems.append(name + " still contains a REPLACE placeholder")
    if problems:
        raise CliError("Not pushing " + args.file + ":\n  - " + "\n  - ".join(problems), code=2)

    out("About to REPLACE all environment variables on card " + card_key + " with these "
        + str(len(variables)) + " names (values are not shown):")
    for name in sorted(variables):
        out("  " + name)
    out("Any variable on the card that is not in this list will be deleted.")
    if not args.yes:
        out("")
        out("Nothing was changed. Re-run with --yes to apply.")
        return 0

    result = build_api().set_env(card_key, variables)
    names = sorted((result.get("variables") or {}).keys())
    out("Done. The card now has " + str(len(names)) + " variable(s): " + ", ".join(names))
    return 0


def cmd_deploy(args, out):
    card_key = resolve_card_key(args)
    code = read_text_file(args.file, "the card code")
    if not code.strip():
        raise CliError(args.file + " is empty.")

    api = build_api()
    out("Saving " + args.file + " (" + str(len(code.splitlines())) + " lines) to card " + card_key + "...")
    saved = api.save_code(card_key, code)
    code_id = saved.get("codeId")
    if not code_id:
        raise CliError("The save call did not return a codeId, so nothing was published.")
    out("Saved. codeId = " + str(code_id))

    if args.no_publish:
        out("Not published (--no-publish). The code is saved but is NOT live.")
        return 0

    out("Publishing...")
    published = api.publish_code(card_key, code_id, code)
    out("Published. codeId = " + str(published.get("codeId")) + ", publishedAt = "
        + str(published.get("publishedAt")))

    live = api.get_published_code(card_key).get("code", "")
    if live == code:
        out("Verified: the published code matches " + args.file + " exactly.")
    else:
        out("WARNING: the published code differs from " + args.file + " ("
            + str(len(live)) + " vs " + str(len(code)) + " characters). It may just be "
            "whitespace normalisation; run 'show --published' to compare.")
    out("")
    out("Remember: environment variables are separate. Run 'env-push' if you have not "
        "set them, then simulate a transaction before relying on it.")
    return 0


def cmd_show(args, out):
    card_key = resolve_card_key(args)
    api = build_api()
    result = api.get_published_code(card_key) if args.published else api.get_saved_code(card_key)
    out(result.get("code", ""))
    return 0


def cmd_simulate(args, out):
    card_key = resolve_card_key(args)
    code = read_text_file(args.file, "the card code")
    try:
        cents = int(round(float(args.amount) * 100))
    except ValueError:
        raise CliError("--amount must be a number of rand, e.g. 125.50", code=2)
    if cents <= 0:
        raise CliError("--amount must be above zero.", code=2)

    body = {
        "simulationcode": code,
        "centsAmount": str(cents),
        "currencyCode": args.currency.lower(),
        "merchantCode": int(args.mcc),
        "merchantName": args.merchant,
        "merchantCity": args.city,
        "countryCode": args.country.upper(),
    }
    out("Simulating " + args.file + " on card " + card_key + ": "
        + args.merchant + ", merchant code " + str(args.mcc) + ", "
        + args.currency.upper() + " " + "{0:.2f}".format(cents / 100.0) + ".")
    out("Note: the code runs with the card's saved environment variables, so it will "
        "call your real Worker and add a TEST entry. Delete it in the app afterwards.")
    out("")
    print_executions(api_execute(card_key, body), out, raw=args.raw)
    return 0


def api_execute(card_key, body):
    return build_api().execute(card_key, body)


def cmd_logs(args, out):
    card_key = resolve_card_key(args)
    executions = build_api().get_executions(card_key)
    executions = sorted(executions, key=lambda e: str(e.get("createdAt") or ""), reverse=True)
    if args.limit > 0:
        executions = executions[:args.limit]
    if not executions:
        out("No executions yet.")
        return 0
    print_executions(executions, out, raw=args.raw)
    if not args.raw:
        out("")
        out("(Long numbers are masked. Use --raw to see them, and think before pasting that anywhere.)")
    return 0


# -- entry point ------------------------------------------------------------


def build_parser():
    parser = argparse.ArgumentParser(
        prog="investec_card.py",
        description="Deploy and manage Investec Programmable Card code.",
    )
    sub = parser.add_subparsers(dest="command")
    sub.required = True

    p_cards = sub.add_parser("cards", help="list your cards and find the CardKey")
    p_cards.set_defaults(func=cmd_cards)

    p_env = sub.add_parser("env-push", help="REPLACE the card's environment variables")
    p_env.add_argument("--card-key")
    p_env.add_argument("--file", default="card/env.json")
    p_env.add_argument("--yes", action="store_true", help="actually apply the change")
    p_env.set_defaults(func=cmd_env_push)

    p_deploy = sub.add_parser("deploy", help="save, publish and verify the card code")
    p_deploy.add_argument("--card-key")
    p_deploy.add_argument("--file", default="card/main.js")
    p_deploy.add_argument("--no-publish", action="store_true", help="save only; do not go live")
    p_deploy.set_defaults(func=cmd_deploy)

    p_show = sub.add_parser("show", help="print the code currently on the card")
    p_show.add_argument("--card-key")
    p_show.add_argument("--published", action="store_true", help="the live code, not the saved draft")
    p_show.set_defaults(func=cmd_show)

    p_sim = sub.add_parser("simulate", help="run the code against a mock transaction")
    p_sim.add_argument("--card-key")
    p_sim.add_argument("--file", default="card/main.js")
    p_sim.add_argument("--mcc", type=int, default=5812, help="merchant category code (default 5812, restaurants)")
    p_sim.add_argument("--amount", default="125.50", help="amount in the currency's main unit (default 125.50)")
    p_sim.add_argument("--currency", default="zar")
    p_sim.add_argument("--merchant", default="Test Merchant")
    p_sim.add_argument("--city", default="Cape Town")
    p_sim.add_argument("--country", default="ZA")
    p_sim.add_argument("--raw", action="store_true", help="do not mask long numbers in the output")
    p_sim.set_defaults(func=cmd_simulate)

    p_logs = sub.add_parser("logs", help="show recent execution logs")
    p_logs.add_argument("--card-key")
    p_logs.add_argument("--limit", type=int, default=10, help="how many executions (default 10, 0 = all)")
    p_logs.add_argument("--raw", action="store_true", help="do not mask long numbers in the output")
    p_logs.set_defaults(func=cmd_logs)
    return parser


def main(argv=None, out=print):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args, out)
    except CliError as exc:
        sys.stderr.write("Error: " + str(exc) + "\n")
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
