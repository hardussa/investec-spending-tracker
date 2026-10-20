#!/usr/bin/env python3
"""
Scan this project for things that should not be published.

Run it before you push, and in CI:

    python scripts/scan_for_secrets.py
    python scripts/scan_for_secrets.py --deny my-subdomain --deny my-team-name

It looks for:

    email         any email address that is not on a reserved example domain
    jwt           JSON Web Token shaped strings (eyJ...)
    hex           long hexadecimal strings: Cloudflare account ids, AUD tags,
                  KV ids and many API keys look like this
    private-key   PEM private key blocks
    workers-dev   real-looking *.workers.dev addresses
    team-domain   real-looking *.cloudflareaccess.com addresses
    deny          anything you pass with --deny (case-insensitive). Use this for
                  your own identifiers: they are never written to disk
    digits        long digit runs (account numbers, card ids). A WARNING only.

Exit status is 1 if any ERROR is found, otherwise 0. A clean scan is a safety
net, not a guarantee: read your diff too.

Works on Python 3.7 and newer. No dependencies.
"""

import argparse
import os
import re
import sys

SKIP_DIRS = {".git", "node_modules", ".wrangler", "__pycache__", ".venv", "venv", ".idea", ".vscode"}
SKIP_FILES = {"package-lock.json"}
SKIP_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pyc", ".zip", ".gz", ".woff", ".woff2", ".pdf"}
MAX_FILE_BYTES = 2 * 1024 * 1024

# Domains reserved by RFC 2606 for documentation. Safe to publish.
SAFE_EMAIL_DOMAINS = {"example.com", "example.org", "example.net"}

# A match containing one of these words is a placeholder, not a real identifier.
PLACEHOLDER_WORDS = ("your", "replace", "example", "test", "placeholder", "xxxx")

# Documentation examples from Investec's own public API specification.
KNOWN_FAKE_DIGITS = {"10011001100", "177778438355553632224", "1010101", "1020202", "1030303"}

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
JWT = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*")
HEX = re.compile(r"\b[0-9a-fA-F]{32,}\b")
PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
WORKERS_DEV = re.compile(r"\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)?\.workers\.dev\b", re.IGNORECASE)
TEAM_DOMAIN = re.compile(r"\b[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com\b", re.IGNORECASE)
DIGITS = re.compile(r"(?<![0-9A-Za-z.])\d{9,}(?![0-9A-Za-z.])")


def mask(text):
    """Show enough to locate a finding without republishing the secret."""
    text = text.strip()
    if len(text) <= 8:
        return text[:2] + "..."
    return text[:4] + "..." + text[-2:] + " (" + str(len(text)) + " chars)"


def is_placeholder(text):
    low = text.lower()
    return any(word in low for word in PLACEHOLDER_WORDS)


def is_trivial_digits(text):
    """A made-up number: one digit repeated, a counting sequence, or an epoch-ms timestamp."""
    if len(set(text)) == 1:
        return True
    if text in ("12345678901234567890" * 2) or text in ("09876543210987654321" * 2):
        return True
    # A plausible millisecond timestamp (roughly 2014 to 2049): 13 digits.
    return len(text) == 13 and text[0] in "12" and 14 <= int(text[:2]) <= 24


def is_trivial_hex(text):
    """0123456789abcdef repeated, or one character repeated: obviously made up."""
    low = text.lower()
    if len(set(low)) <= 2:
        return True
    return low == ("0123456789abcdef" * 8)[:len(low)]


def scan_line(line, deny):
    """Yield (severity, rule, excerpt) for each finding on one line."""
    for m in EMAIL.finditer(line):
        if m.group(1).lower() not in SAFE_EMAIL_DOMAINS:
            yield ("ERROR", "email", mask(m.group(0)))
    for m in JWT.finditer(line):
        yield ("ERROR", "jwt", mask(m.group(0)))
    for m in HEX.finditer(line):
        if not is_trivial_hex(m.group(0)):
            yield ("ERROR", "hex", mask(m.group(0)))
    if PRIVATE_KEY.search(line):
        yield ("ERROR", "private-key", "PEM private key block")
    for m in WORKERS_DEV.finditer(line):
        if not is_placeholder(m.group(0)):
            yield ("ERROR", "workers-dev", mask(m.group(0)))
    for m in TEAM_DOMAIN.finditer(line):
        if not is_placeholder(m.group(0)):
            yield ("ERROR", "team-domain", mask(m.group(0)))
    low = line.lower()
    for term in deny:
        if term and term in low:
            yield ("ERROR", "deny", "contains a --deny term (" + str(len(term)) + " chars)")
    for m in DIGITS.finditer(line):
        if m.group(0) not in KNOWN_FAKE_DIGITS and not is_trivial_digits(m.group(0)):
            yield ("WARNING", "digits", mask(m.group(0)))


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name in SKIP_FILES or os.path.splitext(name)[1].lower() in SKIP_EXTENSIONS:
                continue
            yield os.path.join(dirpath, name)


def scan(root, deny, out=print):
    errors = 0
    warnings = 0
    scanned = 0
    for path in iter_files(root):
        try:
            if os.path.getsize(path) > MAX_FILE_BYTES:
                continue
            with open(path, "r", encoding="utf-8", errors="strict") as handle:
                lines = handle.read().splitlines()
        except (UnicodeDecodeError, OSError):
            continue          # binary or unreadable: nothing textual to scan
        scanned += 1
        rel = os.path.relpath(path, root)
        # File names can leak too.
        for term in deny:
            if term and term in rel.lower():
                out("ERROR   " + rel + ": [deny] the file name contains a --deny term")
                errors += 1
        for number, line in enumerate(lines, 1):
            for severity, rule, excerpt in scan_line(line, deny):
                out("{0:<7} {1}:{2}: [{3}] {4}".format(severity, rel, number, rule, excerpt))
                if severity == "ERROR":
                    errors += 1
                else:
                    warnings += 1
    return scanned, errors, warnings


def main(argv=None, out=print):
    parser = argparse.ArgumentParser(description="Scan a project for secrets and personal identifiers.")
    parser.add_argument("path", nargs="?", default=None, help="folder to scan (default: the project root)")
    parser.add_argument("--deny", action="append", default=[],
                        help="a string that must not appear anywhere (repeatable, case-insensitive)")
    args = parser.parse_args(argv)

    root = args.path or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    deny = [d.strip().lower() for d in args.deny if d and d.strip()]
    scanned, errors, warnings = scan(root, deny, out=out)

    out("")
    out("Scanned " + str(scanned) + " text files: " + str(errors) + " error(s), " + str(warnings) + " warning(s).")
    if errors:
        out("FAILED. Remove or rotate whatever was found before publishing.")
        return 1
    if warnings:
        out("Passed, but review the warnings above: long digit runs can be account or card numbers.")
    else:
        out("Passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
