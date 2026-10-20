"""
Tests for scripts/investec_card.py.

No network is used. A fake Investec API stands in for requests.request and
enforces the request contracts from Investec's Card API specification (paths,
headers, body shapes), so a wrong call fails here rather than against a real
card. Every credential below is a made-up test value.

Runs on Python 3.7+:   python -m unittest discover -s test -p "test_*.py"
"""

import base64
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import investec_card  # noqa: E402

CLIENT_ID = "test-client-id"
CLIENT_SECRET = "test-client-secret-value"
API_KEY = "test-api-key-value"
TOKEN = "test-bearer-token-value"
CARD_KEY = "1010101"
SECRETS = [CLIENT_SECRET, API_KEY, TOKEN]

BASE_ENV = {
    "INVESTEC_CLIENT_ID": CLIENT_ID,
    "INVESTEC_CLIENT_SECRET": CLIENT_SECRET,
    "INVESTEC_API_KEY": API_KEY,
}

# Shaped like the spec's example response, including the fields we must NOT print.
CARDS = [
    {"CardKey": "1010101", "CardNumber": "402167XXXXXX1111", "IsProgrammable": True,
     "Status": "Active", "CardTypeCode": "VGC", "AccountNumber": "10011001100",
     "AccountId": "177778438355553632224", "EmbossedName": "JOHN SMITH", "IsVirtualCard": False},
    {"CardKey": "1020202", "CardNumber": "402167XXXXXX2222", "IsProgrammable": False,
     "Status": "Dormant", "CardTypeCode": "VGC", "AccountNumber": "10011001100",
     "AccountId": "177778438355553632224", "EmbossedName": "JANE DOE", "IsVirtualCard": True},
]


class FakeResponse(object):
    def __init__(self, status=200, payload=None, text=None):
        self.status_code = status
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload)

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


class FakeInvestec(object):
    """Stands in for requests.request and enforces the documented contracts."""

    def __init__(self):
        self.calls = []
        self.saved_code = ""
        self.published_code = ""
        self.env_vars = {}
        self.fail_with = None          # (status, text) to force an HTTP error on non-token calls
        self.raise_exc = None
        self.published_override = None
        self.executions = []

    def __call__(self, method, url, headers=None, timeout=None, data=None, **kwargs):
        if self.raise_exc is not None:
            raise self.raise_exc
        headers = headers or {}
        path = url.split("investec.com", 1)[1] if "investec.com" in url else url.split("://", 1)[1].split("/", 1)[1]
        path = "/" + path.lstrip("/")
        self.calls.append({"method": method, "path": path, "headers": dict(headers), "data": data, "url": url})
        assert timeout, "every request must have a timeout"

        if path == "/identity/v2/oauth2/token":
            expected = "Basic " + base64.b64encode((CLIENT_ID + ":" + CLIENT_SECRET).encode()).decode()
            assert method == "POST"
            assert headers.get("Authorization") == expected, "token call needs Basic client_id:client_secret"
            assert headers.get("x-api-key") == API_KEY
            assert headers.get("Content-Type") == "application/x-www-form-urlencoded"
            assert data == {"grant_type": "client_credentials"}
            return FakeResponse(200, {"access_token": TOKEN, "token_type": "Bearer", "expires_in": 1799, "scope": "cards"})

        assert headers.get("Authorization") == "Bearer " + TOKEN, "API calls need the bearer token"
        if self.fail_with:
            return FakeResponse(self.fail_with[0], None, self.fail_with[1])

        body = json.loads(data) if isinstance(data, str) else None
        card = "/za/v1/cards/" + CARD_KEY

        if method == "GET" and path == "/za/v1/cards":
            return FakeResponse(200, {"data": {"cards": CARDS}})
        if path == card + "/environmentvariables" and method == "POST":
            assert list(body.keys()) == ["variables"], "body must be {variables: {...}}"
            assert all(isinstance(v, str) for v in body["variables"].values())
            self.env_vars = body["variables"]
            return FakeResponse(200, {"data": {"result": {"variables": self.env_vars, "error": None}}})
        if path == card + "/code" and method == "POST":
            assert list(body.keys()) == ["code"]
            self.saved_code = body["code"]
            return FakeResponse(200, {"data": {"result": {"codeId": "CODE-1", "code": body["code"]}}})
        if path == card + "/publish" and method == "POST":
            assert set(body.keys()) == {"codeid", "code"}, "publish needs lowercase codeid and code"
            assert body["codeid"] == "CODE-1" and body["code"] == self.saved_code
            self.published_code = body["code"]
            return FakeResponse(200, {"data": {"result": {"codeId": "CODE-1", "publishedAt": "2026-01-01T00:00:00.000Z"}}})
        if path == card + "/code" and method == "GET":
            return FakeResponse(200, {"data": {"result": {"codeId": "CODE-1", "code": self.saved_code}}})
        if path == card + "/publishedcode" and method == "GET":
            shown = self.published_override if self.published_override is not None else self.published_code
            return FakeResponse(200, {"data": {"result": {"codeId": "CODE-1", "code": shown}}})
        if path == card + "/code/execute" and method == "POST":
            for key in ("simulationcode", "centsAmount", "currencyCode", "merchantCode",
                        "merchantName", "merchantCity", "countryCode"):
                assert key in body, "simulation body is missing " + key
            assert isinstance(body["centsAmount"], str), "centsAmount is a string in the spec"
            assert isinstance(body["merchantCode"], int), "merchantCode is a number in the spec"
            self.last_simulation = body
            return FakeResponse(200, {"data": {"result": self.executions}})
        if path == card + "/code/executions" and method == "GET":
            return FakeResponse(200, {"data": {"result": self.executions}})
        raise AssertionError("unexpected call: " + method + " " + path)

    def paths(self):
        return [c["method"] + " " + c["path"] for c in self.calls]


def run(args, fake, env=None, files=None):
    """Run the CLI; return (exit_code, stdout_lines, stderr_text)."""
    out = []
    err = io.StringIO()
    full_env = dict(BASE_ENV)
    full_env.update(env or {})
    with mock.patch.dict(os.environ, full_env, clear=True), \
            mock.patch.object(investec_card.requests, "request", fake), \
            redirect_stderr(err):
        code = investec_card.main(args, out=out.append)
    return code, out, err.getvalue()


def write_temp(text, suffix=""):
    handle, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(handle, "w", encoding="utf-8") as f:
        f.write(text)
    return path


class SecretsNeverLeak(unittest.TestCase):
    def assert_no_secrets(self, out, err):
        blob = "\n".join(out) + "\n" + err
        for secret in SECRETS:
            self.assertNotIn(secret, blob, "a credential appeared in the output")


class TestCredentials(SecretsNeverLeak):
    def test_missing_credentials_name_the_variables_not_the_values(self):
        fake = FakeInvestec()
        with mock.patch.dict(os.environ, {"INVESTEC_CLIENT_ID": CLIENT_ID}, clear=True), \
                mock.patch.object(investec_card.requests, "request", fake):
            err = io.StringIO()
            with redirect_stderr(err):
                code = investec_card.main(["cards"], out=lambda s: None)
        self.assertEqual(code, 2)
        self.assertIn("INVESTEC_CLIENT_SECRET", err.getvalue())
        self.assertIn("INVESTEC_API_KEY", err.getvalue())
        self.assertNotIn(CLIENT_ID, err.getvalue())
        self.assertEqual(fake.calls, [], "no request may be made without credentials")

    def test_blank_credentials_count_as_missing(self):
        code, out, err = run(["cards"], FakeInvestec(), env={"INVESTEC_API_KEY": "   "})
        self.assertEqual(code, 2)

    def test_credentials_are_not_accepted_on_the_command_line(self):
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            investec_card.build_parser().parse_args(["cards", "--client-secret", "x"])

    def test_token_request_follows_the_spec(self):
        fake = FakeInvestec()           # asserts inside __call__
        code, out, err = run(["cards"], fake)
        self.assertEqual(code, 0)
        self.assertEqual(fake.paths()[0], "POST /identity/v2/oauth2/token")

    def test_base_url_can_be_overridden(self):
        fake = FakeInvestec()
        run(["cards"], fake, env={"INVESTEC_BASE_URL": "https://openapi.investec.com/"})
        self.assertTrue(fake.calls[0]["url"].startswith("https://openapi.investec.com/identity"))
        self.assertNotIn("//identity", fake.calls[0]["url"].replace("https://", ""))


class TestCards(SecretsNeverLeak):
    def test_lists_what_is_needed_to_pick_a_card(self):
        code, out, err = run(["cards"], FakeInvestec())
        text = "\n".join(out)
        self.assertEqual(code, 0)
        self.assertIn("1010101", text)
        self.assertIn("402167XXXXXX1111", text)
        self.assertIn("Active", text)

    def test_never_prints_account_numbers_or_names(self):
        code, out, err = run(["cards"], FakeInvestec())
        text = "\n".join(out) + err
        for private in ("10011001100", "177778438355553632224", "JOHN SMITH", "JANE DOE"):
            self.assertNotIn(private, text, private + " must not be printed")
        self.assert_no_secrets(out, err)

    def test_says_which_cards_are_programmable(self):
        code, out, err = run(["cards"], FakeInvestec())
        rows = [l for l in out if l.startswith("1010101") or l.startswith("1020202")]
        self.assertIn("yes", rows[0])
        self.assertIn("no", rows[1])


class TestDeploy(SecretsNeverLeak):
    def setUp(self):
        self.code_path = write_temp("const beforeTransaction = async () => true;\n", ".js")
        self.addCleanup(os.remove, self.code_path)

    def test_saves_then_publishes_then_verifies(self):
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--card-key", CARD_KEY, "--file", self.code_path], fake)
        self.assertEqual(code, 0, err)
        self.assertEqual(fake.paths(), [
            "POST /identity/v2/oauth2/token",
            "POST /za/v1/cards/1010101/code",
            "POST /za/v1/cards/1010101/publish",
            "GET /za/v1/cards/1010101/publishedcode",
        ])
        self.assertEqual(fake.published_code, "const beforeTransaction = async () => true;\n")
        self.assertIn("Verified", "\n".join(out))
        self.assert_no_secrets(out, err)

    def test_card_key_can_come_from_the_environment(self):
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--file", self.code_path], fake, env={"INVESTEC_CARD_KEY": CARD_KEY})
        self.assertEqual(code, 0, err)

    def test_no_publish_leaves_the_code_saved_but_not_live(self):
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--card-key", CARD_KEY, "--file", self.code_path, "--no-publish"], fake)
        self.assertEqual(code, 0)
        self.assertNotIn("POST /za/v1/cards/1010101/publish", fake.paths())
        self.assertIn("NOT live", "\n".join(out))

    def test_warns_when_the_live_code_differs(self):
        fake = FakeInvestec()
        fake.published_override = "something else"
        code, out, err = run(["deploy", "--card-key", CARD_KEY, "--file", self.code_path], fake)
        self.assertEqual(code, 0)
        self.assertIn("WARNING", "\n".join(out))

    def test_missing_file_is_a_clean_error(self):
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--card-key", CARD_KEY, "--file", "/no/such/file.js"], fake)
        self.assertEqual(code, 1)
        self.assertIn("Cannot read", err)
        self.assertEqual(fake.calls, [])

    def test_empty_file_is_refused_before_any_request(self):
        empty = write_temp("  \n")
        self.addCleanup(os.remove, empty)
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--card-key", CARD_KEY, "--file", empty], fake)
        self.assertEqual(code, 1)
        self.assertEqual(fake.calls, [])

    def test_no_card_selected_is_a_clear_error(self):
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--file", self.code_path], fake)
        self.assertEqual(code, 2)
        self.assertIn("cards", err)
        self.assertEqual(fake.calls, [])

    def test_a_card_key_cannot_smuggle_a_path(self):
        for bad in ("../admin", "1010101/code", "a b", "1010101?x=1", "%2e%2e"):
            fake = FakeInvestec()
            code, out, err = run(["deploy", "--card-key", bad, "--file", self.code_path], fake)
            self.assertEqual(code, 2, bad)
            self.assertEqual(fake.calls, [], "no request may be made for " + bad)

    def test_the_shipped_card_code_deploys(self):
        shipped = os.path.join(ROOT, "card", "main.js")
        fake = FakeInvestec()
        code, out, err = run(["deploy", "--card-key", CARD_KEY, "--file", shipped], fake)
        self.assertEqual(code, 0, err)
        with open(shipped, encoding="utf-8") as f:
            self.assertEqual(fake.published_code, f.read())


class TestEnvPush(SecretsNeverLeak):
    def make_env(self, content):
        path = write_temp(content if isinstance(content, str) else json.dumps(content), ".json")
        self.addCleanup(os.remove, path)
        return path

    GOOD = {"workerUrl": "https://example.workers.dev", "cardKey": "test-shared-secret-123",
            "cfAccessClientSecret": "test-cf-secret-456"}

    def test_without_yes_nothing_is_changed(self):
        fake = FakeInvestec()
        code, out, err = run(["env-push", "--card-key", CARD_KEY, "--file", self.make_env(self.GOOD)], fake)
        self.assertEqual(code, 0)
        self.assertEqual(fake.calls, [], "a dry run must not even authenticate")
        text = "\n".join(out)
        self.assertIn("Nothing was changed", text)
        self.assertIn("REPLACE all", text)

    def test_with_yes_it_replaces_the_variables(self):
        fake = FakeInvestec()
        code, out, err = run(["env-push", "--card-key", CARD_KEY, "--yes", "--file", self.make_env(self.GOOD)], fake)
        self.assertEqual(code, 0, err)
        self.assertEqual(fake.env_vars, self.GOOD)

    def test_values_are_never_printed(self):
        for extra in ([], ["--yes"]):
            code, out, err = run(["env-push", "--card-key", CARD_KEY, "--file", self.make_env(self.GOOD)] + extra, FakeInvestec())
            blob = "\n".join(out) + err
            for value in self.GOOD.values():
                self.assertNotIn(value, blob)
            self.assert_no_secrets(out, err)

    def test_names_are_listed_so_you_can_see_what_will_be_deleted(self):
        code, out, err = run(["env-push", "--card-key", CARD_KEY, "--file", self.make_env(self.GOOD)], FakeInvestec())
        for name in self.GOOD:
            self.assertIn(name, "\n".join(out))

    def test_refuses_unfilled_placeholders(self):
        example = os.path.join(ROOT, "card", "env.example.json")
        fake = FakeInvestec()
        code, out, err = run(["env-push", "--card-key", CARD_KEY, "--yes", "--file", example], fake)
        self.assertEqual(code, 2)
        self.assertIn("REPLACE", err)
        self.assertEqual(fake.calls, [])

    def test_refuses_bad_files(self):
        cases = {
            "not json": "{nope",
            "a list": "[1, 2]",
            "empty object": "{}",
            "a number value": {"a": 5},
            "an empty value": {"a": "  "},
            "a null value": {"a": None},
            "a nested value": {"a": {"b": "c"}},
        }
        for label, content in cases.items():
            fake = FakeInvestec()
            code, out, err = run(["env-push", "--card-key", CARD_KEY, "--yes", "--file", self.make_env(content)], fake)
            self.assertIn(code, (1, 2), label)
            self.assertEqual(fake.calls, [], label + " must not reach the API")


class TestShow(SecretsNeverLeak):
    def setUp(self):
        self.fake = FakeInvestec()
        self.fake.saved_code = "// saved draft"
        self.fake.published_code = "// live version"

    def test_shows_the_saved_draft_by_default(self):
        code, out, err = run(["show", "--card-key", CARD_KEY], self.fake)
        self.assertEqual(code, 0)
        self.assertEqual(out, ["// saved draft"])
        self.assertIn("GET /za/v1/cards/1010101/code", self.fake.paths())

    def test_shows_the_live_code_with_published(self):
        code, out, err = run(["show", "--card-key", CARD_KEY, "--published"], self.fake)
        self.assertEqual(out, ["// live version"])
        self.assertIn("GET /za/v1/cards/1010101/publishedcode", self.fake.paths())


class TestSimulateAndLogs(SecretsNeverLeak):
    EXECUTIONS = [
        {"executionId": "A", "type": "before_transaction", "sandbox": True, "authorizationApproved": True,
         "startedAt": "2026-01-01T10:00:00.000Z", "createdAt": "2026-01-01T10:00:00.000Z", "Error": None,
         "logs": [{"level": "info", "content": "approving. accountNumber=10011001100 centsAmount=12550"}]},
        {"executionId": "B", "type": "after_transaction", "sandbox": True, "authorizationApproved": None,
         "startedAt": "2026-01-01T10:00:05.000Z", "createdAt": "2026-01-01T10:00:05.000Z", "Error": None,
         "logs": [{"level": "info", "content": "Logged under dining"}]},
        {"executionId": "C", "type": "before_transaction", "sandbox": False, "authorizationApproved": False,
         "startedAt": "2026-01-02T09:00:00.000Z", "createdAt": "2026-01-02T09:00:00.000Z",
         "Error": "boom 123456789012", "logs": []},
    ]

    def setUp(self):
        self.code_path = write_temp("// code", ".js")
        self.addCleanup(os.remove, self.code_path)

    def test_simulate_sends_a_spec_shaped_body(self):
        fake = FakeInvestec()
        fake.executions = self.EXECUTIONS[:2]
        code, out, err = run(["simulate", "--card-key", CARD_KEY, "--file", self.code_path,
                              "--mcc", "7011", "--amount", "840.5", "--currency", "EUR",
                              "--merchant", "Test Hotel"], fake)
        self.assertEqual(code, 0, err)
        sent = fake.last_simulation
        self.assertEqual(sent["centsAmount"], "84050")
        self.assertEqual(sent["merchantCode"], 7011)
        self.assertEqual(sent["currencyCode"], "eur")
        self.assertEqual(sent["merchantName"], "Test Hotel")
        self.assertEqual(sent["countryCode"], "ZA")
        self.assertEqual(sent["simulationcode"], "// code")

    def test_simulate_warns_that_it_adds_a_test_entry(self):
        fake = FakeInvestec()
        code, out, err = run(["simulate", "--card-key", CARD_KEY, "--file", self.code_path], fake)
        self.assertIn("TEST entry", "\n".join(out))

    def test_simulate_rejects_bad_amounts_before_any_request(self):
        for bad in ("abc", "0", "-5"):
            fake = FakeInvestec()
            code, out, err = run(["simulate", "--card-key", CARD_KEY, "--file", self.code_path, "--amount", bad], fake)
            self.assertEqual(code, 2, bad)
            self.assertEqual(fake.calls, [], bad)

    def test_logs_are_masked_by_default(self):
        fake = FakeInvestec()
        fake.executions = self.EXECUTIONS
        code, out, err = run(["logs", "--card-key", CARD_KEY], fake)
        text = "\n".join(out)
        self.assertNotIn("10011001100", text)
        self.assertNotIn("123456789012", text)
        self.assertIn("[number]", text)
        self.assertIn("centsAmount=12550", text, "short numbers like amounts are kept")

    def test_raw_shows_everything(self):
        fake = FakeInvestec()
        fake.executions = self.EXECUTIONS
        code, out, err = run(["logs", "--card-key", CARD_KEY, "--raw"], fake)
        self.assertIn("10011001100", "\n".join(out))

    def test_newest_first_and_limit(self):
        fake = FakeInvestec()
        fake.executions = self.EXECUTIONS
        code, out, err = run(["logs", "--card-key", CARD_KEY, "--limit", "1"], fake)
        headers = [l for l in out if l.startswith("---")]
        self.assertEqual(len(headers), 1)
        self.assertIn("2026-01-02", headers[0])
        self.assertIn("DECLINED", headers[0])
        self.assertIn("(live)", headers[0])

    def test_empty_log_output_is_explained(self):
        fake = FakeInvestec()
        fake.executions = self.EXECUTIONS
        code, out, err = run(["logs", "--card-key", CARD_KEY], fake)
        self.assertIn("without calling console.log", "\n".join(out))

    def test_no_executions(self):
        fake = FakeInvestec()
        code, out, err = run(["logs", "--card-key", CARD_KEY], fake)
        self.assertEqual(out, ["No executions yet."])


class TestFailures(SecretsNeverLeak):
    def test_http_errors_are_explained_without_leaking_credentials(self):
        for status, hint in ((401, "credentials"), (403, "not permitted"), (429, "wait")):
            fake = FakeInvestec()
            fake.fail_with = (status, "denied")
            code, out, err = run(["cards"], fake)
            self.assertEqual(code, 1)
            self.assertIn("HTTP " + str(status), err)
            self.assertIn(hint, err)
            self.assert_no_secrets(out, err)

    def test_network_failure_is_a_clean_error(self):
        fake = FakeInvestec()
        fake.raise_exc = investec_card.requests.exceptions.ConnectionError("boom " + CLIENT_SECRET)
        code, out, err = run(["cards"], fake)
        self.assertEqual(code, 1)
        self.assertIn("Could not reach", err)
        self.assertIn("ConnectionError", err)
        self.assertNotIn(CLIENT_SECRET, err, "the exception text must not be echoed")

    def test_non_json_response_is_a_clean_error(self):
        class HtmlFake(FakeInvestec):
            def __call__(self, method, url, **kw):
                return FakeResponse(200, None, "<html>maintenance</html>")
        code, out, err = run(["cards"], HtmlFake())
        self.assertEqual(code, 1)
        self.assertIn("not JSON", err)

    def test_token_endpoint_without_a_token(self):
        class NoToken(FakeInvestec):
            def __call__(self, method, url, **kw):
                return FakeResponse(200, {"something": "else"})
        code, out, err = run(["cards"], NoToken())
        self.assertEqual(code, 1)
        self.assertIn("access_token", err)

    def test_the_card_key_in_error_urls_is_fine_but_headers_are_never_printed(self):
        fake = FakeInvestec()
        fake.fail_with = (500, "internal error")
        code, out, err = run(["show", "--card-key", CARD_KEY], fake)
        self.assertNotIn("Bearer", err)
        self.assertNotIn("Authorization", err)


if __name__ == "__main__":
    unittest.main()
