#!/data/data/com.termux/files/usr/bin/bash
# End-to-end sandbox for install-dsh.sh.
#
# Runs the real installer against a throwaway prefix and a throwaway HOME, with
# the mutating external commands (dpkg / pkg / cmake / npx / npm) replaced by
# stubs, so no network, no compiler and no real installation is touched. The fake
# dsh tree starts as the *upstream* bytes — obtained by reverting this repository's
# own patch registry on copies of the live files — which is exactly what a fresh
# install sees.
#
# It asserts the three behaviours the plugin-ownership change introduced:
#   A. default              -> steps 5/7/8 all patch the fake tree;
#   B. skip flag, no plugin -> warns and still patches (fail-safe);
#   C. skip flag + plugin   -> steps 7/8 skipped, step 5 still applied.
#
# Usage: bash tests/install-dsh-sandbox.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO/install-dsh.sh"
PKG="$REPO/dsh-android-fixes"
LIVE_DSH="${DSH_DIR:-$PREFIX/lib/node_modules/@deepseek-ai/dsh}"

WORK="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/dsh-installer-sandbox-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# ------------------------------------------------------------------ stubs
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
cat > "$STUBS/dpkg" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$STUBS/pkg" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$STUBS/cmake" <<'EOF'
#!/bin/sh
echo "cmake version 3.31.0"
EOF
cat > "$STUBS/npx" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$STUBS/npm" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-v" ]; then echo "11.22.0"; fi
exit 0
EOF
chmod +x "$STUBS"/*

# ------------------------------------------------- one fake dsh installation
seed_prefix() {
  local prefix="$1" home="$2"
  local dsh="$prefix/lib/node_modules/@deepseek-ai/dsh"
  mkdir -p "$dsh/lib" "$dsh/node_modules" "$prefix/bin" "$home"
  cat > "$dsh/package.json" <<'EOF'
{ "name": "@deepseek-ai/dsh", "version": "0.2.0-rc.2", "main": "lib/bin.js" }
EOF
  cat > "$dsh/lib/bin.js" <<'EOF'
console.log(require('./../package.json').version)
EOF
  # sharp present and loadable, wasm fallback already in place -> step 6 is a no-op
  mkdir -p "$dsh/node_modules/sharp" "$dsh/node_modules/@img/sharp-wasm32"
  printf '{ "name": "sharp", "version": "0.35.5", "main": "index.js" }\n' > "$dsh/node_modules/sharp/package.json"
  printf 'module.exports = { versions: { sharp: "0.35.5" } }\n' > "$dsh/node_modules/sharp/index.js"
  printf '{ "name": "@img/sharp-wasm32", "version": "0.35.5" }\n' > "$dsh/node_modules/@img/sharp-wasm32/package.json"
  for relative in \
    "@deepseek-ai/node-addon-system/lib/flock.js" \
    "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" \
    "@deepseek-ai/dsh-attachment-local/lib/index.js" \
    "@deepseek-ai/dsh-app-boot/lib/index.js" \
    "@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js" \
    "@deepseek-ai/dsh-client-ui-conversation/lib/client.js"; do
    mkdir -p "$(dirname "$dsh/node_modules/$relative")"
    cp "$LIVE_DSH/node_modules/$relative" "$dsh/node_modules/$relative"
  done
  # Revert the copies to upstream with the very registry this repository ships.
  DSH_DIR="$dsh" node --input-type=module -e "
    import { writePatchItem } from '$PKG/src/engine.js'
    import { PATCH_ITEMS } from '$PKG/src/patches.js'
    for (const item of PATCH_ITEMS) writePatchItem(item, process.env.DSH_DIR, false)
  " >/dev/null
}

dsh_dir_of() {
  echo "$1/lib/node_modules/@deepseek-ai/dsh"
}

markers() {
  local dsh
  dsh="$(dsh_dir_of "$1")"
  local total=0
  for relative in \
    "@deepseek-ai/node-addon-system/lib/flock.js" \
    "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" \
    "@deepseek-ai/dsh-attachment-local/lib/index.js" \
    "@deepseek-ai/dsh-app-boot/lib/index.js" \
    "@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js" \
    "@deepseek-ai/dsh-client-ui-conversation/lib/client.js"; do
    if grep -q 'dsh-android' "$dsh/node_modules/$relative" 2>/dev/null; then total=$((total + 1)); fi
  done
  echo "$total"
}

run_installer() {
  local prefix="$1" home="$2"; shift 2
  env -i \
    PATH="$STUBS:/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets:/system/bin" \
    HOME="$home" TMPDIR="$PREFIX/tmp" PREFIX="$PREFIX" \
    DSH_PREFIX="$prefix" TERM=xterm "$@" \
    bash "$INSTALLER" 0.2.0-rc.2 > "$WORK/installer.log" 2>&1
  echo $?
}

# ------------------------------------------------------------- scenario A
echo "A. default run (no skip flag)"
A="$WORK/a"; seed_prefix "$A/prefix" "$A/home"
mkdir -p "$A/home"
CODE="$(run_installer "$A/prefix" "$A/home")"
[ "$CODE" = 0 ] && pass "installer exits 0" || { fail "installer exits 0 (got $CODE)"; tail -20 "$WORK/installer.log"; }
COUNT="$(markers "$A/prefix")"
[ "$COUNT" = 6 ] && pass "all 6 targets patched" || fail "all 6 targets patched (got $COUNT)"
grep -q '已装 dsh-android-fixes 插件' "$WORK/installer.log" && fail "no plugin line without the flag" || pass "no plugin line without the flag"
A_DSH="$(dsh_dir_of "$A/prefix")"
SAME=1
for relative in \
  "@deepseek-ai/node-addon-system/lib/flock.js" \
  "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" \
  "@deepseek-ai/dsh-attachment-local/lib/index.js" \
  "@deepseek-ai/dsh-app-boot/lib/index.js" \
  "@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js" \
  "@deepseek-ai/dsh-client-ui-conversation/lib/client.js"; do
  cmp -s "$A_DSH/node_modules/$relative" "$LIVE_DSH/node_modules/$relative" || SAME=0
done
[ "$SAME" = 1 ] && pass "patched bytes identical to the live production tree" || fail "patched bytes identical to the live production tree"
"$A/prefix/bin/dsh" --version >/dev/null 2>&1 && pass "wrapper script runs" || fail "wrapper script runs"

# ------------------------------------------- scenario B: flag, no plugin
echo
echo "B. DSH_SKIP_RUNTIME_PATCHES=1 with no plugin installed (fail-safe)"
B="$WORK/b"; seed_prefix "$B/prefix" "$B/home"
CODE="$(run_installer "$B/prefix" "$B/home" DSH_SKIP_RUNTIME_PATCHES=1)"
[ "$CODE" = 0 ] && pass "installer exits 0" || { fail "installer exits 0 (got $CODE)"; tail -20 "$WORK/installer.log"; }
grep -q '里没有 dsh-android-fixes' "$WORK/installer.log" && pass "warns that nothing would take over" || fail "warns that nothing would take over"
COUNT="$(markers "$B/prefix")"
[ "$COUNT" = 6 ] && pass "still patched all 6 targets" || fail "still patched all 6 targets (got $COUNT)"

# -------------------------------------- scenario C: flag with plugin present
echo
echo "C. DSH_SKIP_RUNTIME_PATCHES=1 with the plugin listed in a profile"
C="$WORK/c"; seed_prefix "$C/prefix" "$C/home"
mkdir -p "$C/home/.dsh/profiles/web"
cat > "$C/home/.dsh/profiles/web/package.json" <<'EOF'
{ "name": "dsh-profile-web", "private": true, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsha/dsh-android-fixes"] } } }
EOF
CODE="$(run_installer "$C/prefix" "$C/home" DSH_SKIP_RUNTIME_PATCHES=1)"
[ "$CODE" = 0 ] && pass "installer exits 0" || { fail "installer exits 0 (got $CODE)"; tail -20 "$WORK/installer.log"; }
grep -q '已装 dsh-android-fixes 插件' "$WORK/installer.log" && pass "hands steps 7/8 to the plugin" || fail "hands steps 7/8 to the plugin"
C_DSH="$(dsh_dir_of "$C/prefix")"
COUNT="$(markers "$C/prefix")"
[ "$COUNT" = 2 ] && pass "only the 2 app-boot targets patched (step 5 kept)" || fail "only the 2 app-boot targets patched (got $COUNT)"
grep -q 'dsh-android' "$C_DSH/node_modules/@deepseek-ai/node-addon-system/lib/flock.js" && fail "flock untouched" || pass "flock untouched"
grep -q 'dsh-android' "$C_DSH/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js" && fail "composer bundle untouched" || pass "composer bundle untouched"

echo
if [ "$FAILURES" = 0 ]; then echo "INSTALLER SANDBOX PASSED"; else echo "INSTALLER SANDBOX FAILED ($FAILURES)"; fi
exit "$([ "$FAILURES" = 0 ] && echo 0 || echo 1)"
