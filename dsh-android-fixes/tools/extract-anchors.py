#!/usr/bin/env python3
"""Regenerate src/patches.js from the installer's own patch steps.

`install-dsh.sh` is the authority for every anchor and every replacement string
this plugin applies. Rather than retyping them, this script extracts the literals
out of the installer's embedded Python and rewrites `src/patches.js`, so the two
can never drift.

It understands the three shapes the installer uses:

  * step 5 — one `old = '...'` / `new = '...'` literal pair, applied per file;
  * step 7 — `edit(path, [(old, new), ...])` calls; the `edit` body is replaced by
    a recorder so nothing is read or written;
  * step 8 — `lines[i:i] = [...]` / `lines[j+1:j+1] = [...]` line insertions,
    expressed here as the surrounding two-line anchor plus the inserted lines.

Usage:
  python3 tools/extract-anchors.py [path/to/install-dsh.sh]
"""

import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
INSTALLER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PACKAGE, "..", "install-dsh.sh")

# Which extracted file belongs to which registry entry, and in what order the
# entries appear on the settings page. Adding an installer step means adding one
# line here and (for an install-time fact) one entry in src/checks.js.
ENTRIES = [
    ("flock-session-lock", ["@deepseek-ai/node-addon-system/lib/flock.js"]),
    ("session-log-hardlink", ["@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js"]),
    ("attachment-hardlink", ["@deepseek-ai/dsh-attachment-local/lib/index.js"]),
    (
        "app-boot-native-addon",
        [
            "@deepseek-ai/dsh-app-boot/lib/index.js",
            "@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js",
        ],
    ),
    ("composer-enter", ["@deepseek-ai/dsh-client-ui-conversation/lib/client.js"]),
]


def heredoc(source, command, marker):
    """Return one embedded Python block, selected by its `python3 - "<arg>"` line.

    Four steps of the installer use the same `PY` marker, so the command line is
    part of the key.
    """
    pattern = re.escape('python3 - "%s" <<\'%s\'\n' % (command, marker)) + r"(.*?)\n%s\n" % marker
    match = re.search(pattern, source, re.S)
    if match is None:
        raise SystemExit("installer: no heredoc for python3 - \"%s\" <<'%s'" % (command, marker))
    return match.group(1)


def step7_pairs(source):
    body = heredoc(source, "$DSH_DIR", "PY")
    head, sep, tail = body.partition("def edit(path, pairs):\n")
    rest = re.search(r"\n(?=# 7a\.)", tail, re.S)
    neutral = head + sep + "    RECORD.append((path, pairs))\n    return\n" + tail[rest.start():]
    # The block reads sys.argv[1] as its dsh root; give it a fake one so the
    # recorder stub is the only thing that runs.
    saved_argv = sys.argv
    sys.argv = ["extract-anchors", "Fakeroot"]
    try:
        namespace = {"RECORD": []}
        exec(compile(neutral, "<step7>", "exec"), namespace)
    finally:
        sys.argv = saved_argv
    prefix = "Fakeroot/node_modules/"
    return {
        path[len(prefix):]: [[old, new] for old, new in pairs]
        for path, pairs in namespace["RECORD"]
    }


def step5_pair(source):
    body = heredoc(source, "$f", "PY")
    namespace = {}
    exec(compile(body[body.index("old = "):body.index("if s.count(old) != 1:")], "<step5>", "exec"), namespace)
    return [namespace["old"], namespace["new"]]


def step8_pairs(source):
    body = heredoc(source, "$CONV", "PY")
    inserts = []
    for match in re.finditer(r"lines\[[^\]]+\] = (\[.*?\n\])\n", body, re.S):
        namespace = {}
        exec(compile("_v = " + match.group(1), "<step8>", "exec"), namespace)
        inserts.append(namespace["_v"])
    if len(inserts) != 2:
        raise SystemExit("installer: expected two line insertions in step 8, found %d" % len(inserts))
    anchor_a = '\t\t\t\tevent?.preventDefault();\n\t\t\t\tif (event?.repeat === true) return true;'
    anchor_b = '\t\t\t\trootElement = root;\n'
    return [
        [anchor_a, "".join(line + "\n" for line in inserts[0]) + anchor_a],
        [anchor_b, anchor_b + "".join(line + "\n" for line in inserts[1])],
    ]


def main():
    source = io.open(INSTALLER, encoding="utf-8").read()
    files = dict(step7_pairs(source))
    appboot = step5_pair(source)
    for relative in (
        "@deepseek-ai/dsh-app-boot/lib/index.js",
        "@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js",
    ):
        files[relative] = [appboot]
    files["@deepseek-ai/dsh-client-ui-conversation/lib/client.js"] = step8_pairs(source)

    def package_of(relative):
        parts = relative.split("/")
        return "/".join(parts[:2]) if relative.startswith("@") else parts[0]

    rows = []
    for entry_id, relatives in ENTRIES:
        targets = []
        for relative in relatives:
            if relative not in files:
                raise SystemExit("installer: no extracted anchors for %s — did step 7 change?" % relative)
            package = package_of(relative)
            body = "\n".join(
                "\t\t\t\t\t[%s, %s]," % (json.dumps(old, ensure_ascii=False), json.dumps(new, ensure_ascii=False))
                for old, new in files[relative]
            )
            targets.append(
                "\t\t\t{\n\t\t\t\tpackage: %s,\n\t\t\t\tfile: %s,\n\t\t\t\tpairs: [\n%s\n\t\t\t\t],\n\t\t\t},"
                % (json.dumps(package), json.dumps(relative[len(package) + 1:]), body)
            )
        rows.append("\t{\n\t\tid: %s,\n\t\tfiles: [\n%s\n\t\t],\n\t}," % (json.dumps(entry_id), "\n".join(targets)))

    output = HEADER % "\n".join(rows)
    destination = os.path.join(PACKAGE, "src", "patches.js")
    io.open(destination, "w", encoding="utf-8").write(output)
    print("wrote %s (%d entries, %d anchors)" % (destination, len(ENTRIES), sum(len(v) for v in files.values())))


HEADER = '''/**
 * Patch registry for the Android/Termux compatibility fixes.
 *
 * GENERATED by `tools/extract-anchors.py` from `install-dsh.sh` — do not edit the
 * `pairs` by hand. Every pair is `[upstreamText, patchedText]` taken verbatim from
 * the installer (its steps 5, 7 and 8); the installer, not this file, is the
 * authority for the anchors.
 *
 * Each patched target carries a `dsh-android` marker at least once, which makes
 * the transformation strictly reversible: reverting substitutes
 * `patchedText -> upstreamText` and restores the upstream file byte for byte.
 *
 * Adding a fix is one entry here (or one entry in `src/checks.js` for an
 * install-time fact) plus its copy in the client dictionaries and `locale/`.
 *
 * @module src/patches
 */

/** Marker every patched region carries; its presence is what "applied" means. */
export const MARKER = 'dsh-android'

/** Runtime-toggleable file patches (kind `patch`). */
export const PATCH_ITEMS = [
%s
]

/** @returns {string[]} every package a patch item touches, for reporting. */
export function touchedPackages() {
\treturn [...new Set(PATCH_ITEMS.flatMap((item) => item.files.map((file) => file.package)))].sort()
}
'''

if __name__ == "__main__":
    main()
