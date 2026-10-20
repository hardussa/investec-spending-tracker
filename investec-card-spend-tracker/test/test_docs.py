"""
Tests for the documentation.

Docs are instructions people follow literally, so mistakes in them are bugs.
Two classes of mistake have already happened or are easy to make:

  * a `wrangler kv key` command without --remote. In Wrangler 4 that talks to
    local storage on the reader's own computer, so a backup says "Value not
    found" and a restore appears to work but changes nothing real;
  * a link or heading anchor that no longer exists after a heading is renamed.

Runs on Python 3.7+.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".wrangler"}


def markdown_files():
    found = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(".md"):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def code_blocks(text):
    return re.findall(r"```[a-zA-Z]*\n(.*?)```", text, flags=re.S)


def slug(heading):
    """GitHub's heading anchor: lowercase, punctuation stripped, spaces to hyphens."""
    text = re.sub(r"`([^`]*)`", r"\1", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[^\w\- ]", "", text.strip().lower(), flags=re.UNICODE)
    return text.replace(" ", "-")


def anchors(path):
    found, seen, in_code = set(), {}, False
    for line in read(path).splitlines():
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        match = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if match:
            base = slug(match.group(1))
            count = seen.get(base, 0)
            found.add(base if count == 0 else "%s-%d" % (base, count))
            seen[base] = count + 1
    return found


class TestKvCommands(unittest.TestCase):
    def test_every_kv_key_command_in_the_docs_says_where_it_runs(self):
        problems = []
        checked = 0
        for path in markdown_files():
            for block in code_blocks(read(path)):
                for line in block.splitlines():
                    if "wrangler kv key" not in line:
                        continue
                    checked += 1
                    if "--remote" not in line and "--local" not in line and "--help" not in line:
                        problems.append(os.path.relpath(path, ROOT) + ": " + line.strip())
        self.assertGreater(checked, 0, "expected the backup guide to contain kv key commands")
        self.assertEqual(problems, [], "kv key commands must pass --remote (or --local on purpose):\n  "
                         + "\n  ".join(problems))

    def test_backups_do_not_use_text_mode(self):
        """--text appends a newline; a backup should be byte-exact."""
        for path in markdown_files():
            for block in code_blocks(read(path)):
                for line in block.splitlines():
                    if "wrangler kv key get" in line and ">" in line:
                        self.assertNotIn("--text", line, os.path.relpath(path, ROOT))

    def test_the_backup_guide_tells_readers_to_validate_the_file(self):
        text = read(os.path.join(ROOT, "docs", "02-cloudflare-account-and-worker.md"))
        self.assertIn("json.load", text)
        self.assertIn("Value not found", text)


class TestLinks(unittest.TestCase):
    def test_every_relative_link_and_anchor_resolves(self):
        cache = {}
        problems = []
        total = 0
        for path in markdown_files():
            text = re.sub(r"```.*?```", "", read(path), flags=re.S)
            for match in re.finditer(r"\[[^\]]*\]\(([^)\s]+)\)", text):
                link = match.group(1)
                if re.match(r"^(https?:|mailto:)", link):
                    continue
                total += 1
                target, _, fragment = link.partition("#")
                dest = path if not target else os.path.normpath(os.path.join(os.path.dirname(path), target))
                where = os.path.relpath(path, ROOT) + " -> " + link
                if not os.path.exists(dest):
                    problems.append("missing file: " + where)
                    continue
                if fragment and dest.endswith(".md"):
                    if dest not in cache:
                        cache[dest] = anchors(dest)
                    if fragment not in cache[dest]:
                        problems.append("missing anchor: " + where)
        self.assertGreater(total, 20)
        self.assertEqual(problems, [], "\n  " + "\n  ".join(problems))


if __name__ == "__main__":
    unittest.main()
