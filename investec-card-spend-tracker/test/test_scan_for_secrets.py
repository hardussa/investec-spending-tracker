"""
Tests for scripts/scan_for_secrets.py.

Every deliberately "bad" value is assembled at runtime from harmless fragments,
so this file itself contains nothing that looks like a secret and the scanner
can scan its own tests without any exemption. All values are made up.
"""

import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))

import scan_for_secrets as scanner  # noqa: E402


def email(local, domain):
    return local + "@" + domain


def fake_jwt():
    header = "ey" + "JhbGciOiJSUzI1NiIsImtpZCI6Ims"
    payload = "ey" + "JhdWQiOlsiYWJjIl19"
    return header + "." + payload + "." + "c2lnbmF0dXJl"


SECRET_HEX = "3f9a1c7be5d24a08" + "b6c1d2e3f4a5b6c7"          # 32 hex characters
LONG_NUMBER = "48219" + "07365"                                # 10 digits
CARD_LIKE = "4021" + "6712" + "3456" + "1111"                  # 16 digits


class ScannerTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def write(self, name, text):
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def run_scan(self, deny=None):
        lines = []
        args = [self.root]
        for term in deny or []:
            args += ["--deny", term]
        code = scanner.main(args, out=lines.append)
        return code, "\n".join(lines)

    # ---- things that must be caught ----

    def test_real_looking_email_is_an_error(self):
        self.write("a.md", "contact " + email("somebody.real", "mailhost.io") + " for help\n")
        code, out = self.run_scan()
        self.assertEqual(code, 1)
        self.assertIn("[email]", out)

    def test_every_non_example_domain_is_caught(self):
        for addr in (email("a", "mailhost.io"), email("a", "acme-mail.co.za"),
                     email("a", "company.org.za"), email("A.B+tag", "Sub.Domain.io")):
            self.write("a.md", addr + "\n")
            self.assertEqual(self.run_scan()[0], 1, addr)

    def test_a_jwt_is_an_error(self):
        self.write("a.txt", "token " + fake_jwt() + "\n")
        code, out = self.run_scan()
        self.assertEqual(code, 1)
        self.assertIn("[jwt]", out)

    def test_long_hex_like_an_account_id_or_aud_tag_is_an_error(self):
        self.write("a.txt", "id: " + SECRET_HEX + "\n")
        self.assertEqual(self.run_scan()[0], 1)
        self.write("a.txt", "aud: " + SECRET_HEX * 2 + "\n")
        self.assertEqual(self.run_scan()[0], 1)

    def test_a_private_key_block_is_an_error(self):
        self.write("k.txt", "-----BEGIN RSA " + "PRIVATE KEY-----\nabc\n")
        self.assertEqual(self.run_scan()[0], 1)

    def test_a_real_looking_workers_dev_address_is_an_error(self):
        self.write("a.md", "visit https://spend-tracker.janes-stuff" + ".workers" + ".dev/\n")
        code, out = self.run_scan()
        self.assertEqual(code, 1)
        self.assertIn("[workers-dev]", out)

    def test_a_real_looking_team_domain_is_an_error(self):
        self.write("a.md", "login at https://janes-household" + ".cloudflareaccess" + ".com/\n")
        self.assertEqual(self.run_scan()[0], 1)

    def test_deny_terms_are_caught_case_insensitively_in_content_and_names(self):
        self.write("a.md", "Hello from Janes-Household land\n")
        self.assertEqual(self.run_scan(deny=["janes-household"])[0], 1)
        self.write("b-janes-household.md", "innocent\n")
        code, out = self.run_scan(deny=["janes-household"])
        self.assertIn("file name", out)

    def test_findings_are_masked_and_deny_terms_never_echoed(self):
        secret_email = email("very.private.person", "mailhost.io")
        self.write("a.md", secret_email + " " + SECRET_HEX + " mysecretteam\n")
        code, out = self.run_scan(deny=["mysecretteam"])
        self.assertEqual(code, 1)
        self.assertNotIn(secret_email, out)
        self.assertNotIn(SECRET_HEX, out)
        self.assertNotIn("mysecretteam", out)

    def test_reports_the_file_and_line(self):
        self.write("docs/x.md", "fine\nfine\n" + email("bad", "mailhost.io") + "\n")
        code, out = self.run_scan()
        self.assertIn(os.path.join("docs", "x.md") + ":3:", out)

    # ---- things that must be allowed ----

    def test_reserved_example_domains_are_fine(self):
        self.write("a.md", "alex@example.com, sam@Example.ORG, kim@example.net\n")
        code, out = self.run_scan()
        self.assertEqual(code, 0, out)

    def test_placeholders_are_fine(self):
        self.write("a.md",
                   "https://spend-tracker.your-subdomain.workers.dev\n"
                   "https://REPLACE-worker-name.REPLACE-subdomain.workers.dev\n"
                   "https://your-team.cloudflareaccess.com\n"
                   "https://test-team.cloudflareaccess.com\n"
                   "id = \"0123456789abcdef0123456789abcdef\"\n"
                   "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
        code, out = self.run_scan()
        self.assertEqual(code, 0, out)
        self.assertNotIn("WARNING", out, "digits inside a hex string are not a number")

    def test_common_code_does_not_trip_it(self):
        self.write("a.js",
                   "uses: actions/setup-node@v4\n"
                   "\"wrangler\": \"^4.151.1\"\n"
                   "@media (prefers-color-scheme: dark) {}\n"
                   "const x = 12345;\n")
        code, out = self.run_scan()
        self.assertEqual(code, 0, out)

    def test_investecs_documented_example_numbers_are_fine(self):
        self.write("a.py", "AccountNumber: 10011001100 AccountId: 177778438355553632224\n")
        code, out = self.run_scan()
        self.assertEqual(code, 0, out)
        self.assertNotIn("WARNING", out)

    def test_timestamps_and_counting_sequences_are_not_warnings(self):
        self.write("a.md", '"at": 1790000000000 and 123456789012 and 1111111111\n')
        code, out = self.run_scan()
        self.assertEqual(code, 0, out)
        self.assertNotIn("WARNING", out)

    # ---- warnings ----

    def test_unexplained_long_digit_runs_warn_but_do_not_fail(self):
        self.write("a.md", "account " + LONG_NUMBER + "\n")
        code, out = self.run_scan()
        self.assertEqual(code, 0)
        self.assertIn("WARNING", out)
        self.assertIn("digits", out)
        self.assertNotIn(LONG_NUMBER, out, "the number must be masked")

    def test_a_card_number_sized_run_warns(self):
        self.write("a.md", "card " + CARD_LIKE + "\n")
        code, out = self.run_scan()
        self.assertIn("WARNING", out)

    # ---- what it skips ----

    def test_skips_dependencies_and_vcs_and_binaries(self):
        bad = email("bad", "mailhost.io") + "\n"
        self.write("node_modules/x/index.js", bad)
        self.write(".git/config", bad)
        self.write("package-lock.json", bad)
        with open(os.path.join(self.root, "pic.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n\xff\xfe " + bad.encode())
        code, out = self.run_scan()
        self.assertEqual(code, 0, out)

    def test_an_empty_project_passes(self):
        self.assertEqual(self.run_scan()[0], 0)


if __name__ == "__main__":
    unittest.main()
