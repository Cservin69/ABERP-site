#!/usr/bin/env python3
"""Fail-closed lint: every tracked *.svg must be well-formed XML.

Browsers are lenient SVG parsers — they accept, e.g., the string ``--`` inside
an XML comment, which XML 1.0 (§2.5) forbids. Strict readers do not: expat,
libxml2, librsvg (``rsvg-convert``) and resvg (Tauri / any server-side icon
rasteriser) reject it outright. An SVG that only renders in a browser is a
liability for favicons, icon pipelines and SSR — a real one shipped past us
because nothing here parsed the asset strictly. This gate is that missing check.

It enumerates **every tracked** ``*.svg`` via ``git ls-files`` (not a hand-kept
directory list, so a new asset in an unexpected place cannot slip past), and
parses each with expat. It also self-tests its own detector on every run: a
deliberately-malformed sample MUST be rejected and a valid one accepted, or the
gate fails — a lint nobody has watched fail is decoration.

Exit codes: 0 = all well-formed; 1 = a tracked SVG is malformed;
2 = the detector itself is broken (self-test failed).
"""

from __future__ import annotations

import subprocess
import sys
from xml.dom.minidom import parse, parseString


def first_error(fn) -> str | None:
    """Return the first parse-error line, or None if well-formed."""
    try:
        fn()
        return None
    except Exception as e:  # expat raises xml.parsers.expat.ExpatError
        return str(e).splitlines()[0]


# --- self-test: prove the detector actually distinguishes valid from invalid ---
# The malformed sample carries the exact defect class we shipped: `--` in a
# comment. If expat ever accepts it (or rejects the valid control), the detector
# is broken and the whole gate is worthless — fail closed rather than green.
BAD_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><!-- a--b --></svg>'
GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'

if first_error(lambda: parseString(BAD_SVG)) is None:
    print("self-test FAILED: malformed sample was accepted — detector is broken", file=sys.stderr)
    sys.exit(2)
if first_error(lambda: parseString(GOOD_SVG)) is not None:
    print("self-test FAILED: valid sample was rejected — detector is broken", file=sys.stderr)
    sys.exit(2)
print("self-test ok: detector rejects `--`-in-comment and accepts valid SVG")

# --- real check: every tracked *.svg, at any depth ---
files = subprocess.run(
    ["git", "ls-files", "*.svg"],
    capture_output=True,
    text=True,
    check=True,
).stdout.split()

malformed: list[str] = []
for path in files:
    err = first_error(lambda p=path: parse(p))
    if err:
        malformed.append(path)
        print(f"FAIL  {path}  ->  {err}")
    else:
        print(f"PASS  {path}")

print(f"\n{len(files)} tracked SVG(s), {len(malformed)} malformed")
sys.exit(1 if malformed else 0)
