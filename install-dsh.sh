#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# DSH 最简安装脚本 — Android / Termux
# -----------------------------------------------------------------------------
# 只安装原版 @deepseek-ai/dsh，不含任何功能改动：不装 sharp 回退、不打前端/回车
# 补丁、不写启动停止脚本、不改权限模式配置、不切镜像源、不加移动端适配。
#
# 只保留「让原版在 Android 上装得下、起得来、跑得动一轮」的必需步骤：
#   1. 构建依赖（只补缺失，绝不 pkg update）
#   2. 修补 node-gyp 的 common.gypi（定义 android_ndk_path，修 node-pty）
#   3. 用 -target aarch64-linux-android30 编译安装 + 放行原生构建脚本
#      （bionic 在 API 30 才声明 statx()，否则 koffi 编译失败）
#   4. 重建 dsh 包装脚本（npm 只建软链，其 shebang 是 /usr/bin/env，Android 无
#      /usr；且 dsh 需 --expose-internals 才能读 Node 内部模块）
#   5. app-boot 原生 addon 兼容（>= 0.1.6-alpha.2 改用 node-addon-require-builtin
#      读内部模块，该 addon 无 android 预编译包、包内无 C++ 源码）
#   6. Android 运行时兼容（>= 0.2.0 新增的两处硬性依赖）
#      6a. flock 会话锁：node-addon-system 只有 darwin/linux 包，android 平台
#          门禁直接抛 ERR_FLOCK_UNSUPPORTED_PLATFORM，退化为无锁（等价 0.1.x）
#      6b. hardlink：Android/部分 ROM 禁 link(2)（会话日志、附件发布 EACCES）
#          → 会话日志与 staged 附件用 rename；内容寻址的别名发布必须保留源对象，
#            改用 COPYFILE_EXCL 而不是 rename（否则会删掉源对象）
#
# 用法：
#   bash install-dsh.sh              # 装 latest
#   bash install-dsh.sh 0.1.5-rc.3   # 装指定版本
# =============================================================================
set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

DSH_VERSION="${1:-latest}"
PKG="@deepseek-ai/dsh@${DSH_VERSION}"
NPM_PREFIX="${DSH_PREFIX:-$PREFIX}"          # DSH_PREFIX 仅用于测试/自定义前缀
DSH_DIR="$NPM_PREFIX/lib/node_modules/@deepseek-ai/dsh"
WRAPPER="$NPM_PREFIX/bin/dsh"

# --------------------------------------------------------------- 1/7 构建依赖
# 只补齐缺失的包，绝不执行 pkg update：只刷新索引再装个别包会造成 libc++ 半升级，
# 把已装好的 cmake/clang 变成 "CANNOT LINK EXECUTABLE ... cannot locate symbol"。
info "1/7 检查构建依赖"
MISSING=()
for p in cmake clang make binutils pkg-config python nodejs libandroid-spawn; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  info "  缺失，开始安装: ${MISSING[*]}"
  pkg install -y "${MISSING[@]}" >/dev/null
else
  ok "  构建依赖已齐备"
fi
if ! cmake --version >/dev/null 2>&1; then
  warn "cmake 无法运行（Termux 半升级常见故障）。请先执行 pkg upgrade 修好工具链，再重跑本脚本。"
  exit 1
fi
ok "  node $(node -v) / npm $(npm -v)"

# --------------------------------------------------- 2/7 node-gyp headers 补丁
info "2/7 准备 node-gyp headers（node-pty 构建需要，约 1 分钟）"
timeout 300 npx --yes node-gyp install >/dev/null 2>&1 || warn "node-gyp install 未完成，继续"
NODE_VER="$(node -v | sed 's/^v//')"
GYP="$HOME/.cache/node-gyp/$NODE_VER/include/node/common.gypi"
if [ -f "$GYP" ]; then
  python3 - "$GYP" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if "'android_ndk_path%': ''" not in s:
    s = s.replace("'variables': {", "'variables': {\n    'android_ndk_path%': '',", 1)
    open(p, 'w', encoding='utf-8').write(s)
PY
  ok "  common.gypi 已修补 (android_ndk_path='')"
else
  warn "  未找到 $GYP，node-pty 可能编译失败"
fi

# ------------------------------------------------------------------- 3/7 安装
info "3/7 安装 $PKG（含原生编译，约 2~10 分钟，请勿中断）"
CFLAGS="-target aarch64-linux-android30" CXXFLAGS="-target aarch64-linux-android30" \
  npm install -g --prefix "$NPM_PREFIX" \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  --no-fund --no-audit "$PKG"
INSTALLED="$(node -p "require('$DSH_DIR/package.json').version")"
ok "  已安装 @deepseek-ai/dsh@$INSTALLED"

# ------------------------------------------------------------ 4/7 包装脚本
info "4/7 生成 $WRAPPER"
rm -f "$WRAPPER"
cat > "$WRAPPER" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
exec node --expose-internals $DSH_DIR/lib/bin.js "\$@"
EOF
chmod +x "$WRAPPER"
ok "  包装脚本就位（含 --expose-internals）"

# -------------------------------------------------------- 5/7 原生 addon 兼容
info "5/7 app-boot 原生 addon 兼容"
PATCHED=0
for f in "$DSH_DIR/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js" \
         "$DSH_DIR/node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js"; do
  [ -f "$f" ] || continue
  grep -q 'node-addon-require-builtin' "$f" 2>/dev/null || continue
  python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = 'const addon = createRequire(import.meta.url)("node-addon-require-builtin");'
new = ('const _dshReq = createRequire(import.meta.url);\n'
       '\tconst addon = { requireBuiltin: (id) => _dshReq(id) };'
       ' /* dsh-android: 原生 addon 无 android 预编译，改用 --expose-internals */')
if s.count(old) != 1:
    print("  跳过（模式未匹配）:", p)
    sys.exit(0)
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
print("  已修补:", p.rsplit('/', 1)[-1])
PY
  PATCHED=1
done
[ "$PATCHED" = 1 ] && ok "  已改回 --expose-internals 路径" || ok "  该版本不依赖该 addon，无需处理"

# ----------------------------------------------------- 6/7 Android 运行时兼容
info "6/7 Android 运行时兼容补丁（flock / hardlink）"
python3 - "$DSH_DIR" <<'PY'
import io, os, sys

root = sys.argv[1]
NM = os.path.join(root, 'node_modules')

def edit(path, pairs):
    rel = os.path.relpath(path, NM)
    if not os.path.exists(path):
        print("  跳过（文件不存在）:", rel); return
    s = io.open(path, encoding='utf-8').read()
    if 'dsh-android' in s:
        print("  已打过补丁:", rel); return
    for old, new in pairs:
        n = s.count(old)
        if n != 1:
            print("  !! 模式匹配 %d 次，跳过: %s" % (n, rel)); return
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)
    print("  已修补:", rel)

# 6a. flock 会话锁：android 无原生包 → 退化为无锁（等价 0.1.x，调用方仍做 inode 比对）
edit(NM + '/@deepseek-ai/node-addon-system/lib/flock.js', [(
"""export async function tryLockExclusive(fd) {
    const errno = await new Promise((resolve) => {
        loadBinding().tryLock(fd, resolve);
    });""",
"""export async function tryLockExclusive(fd) {
    /* dsh-android: android-arm64 无原生包可装，平台门禁降级为“无锁可用”。 */
    try {
        loadBinding();
    }
    catch (error) {
        if (error?.code === 'ERR_FLOCK_UNSUPPORTED_PLATFORM')
            return;
        throw error;
    }
    const errno = await new Promise((resolve) => {
        loadBinding().tryLock(fd, resolve);
    });""")])

# 6b-1. 会话日志发布：原 link 前已做存在性检查 → rename 等价
edit(NM + '/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', [
 ('import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
  'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";'),
 ('\tlink,\n\trm: (path) => rm(path, { force: true })',
  '''\tlink: async (from, to) => {
\t\t/* dsh-android: 禁 hardlink。改用 rename 原子发布，并保留原 link 的 EEXIST
\t\t   语义——调用方靠它判断“目标已存在，未发布新代”。 */
\t\tlet exists = true;
\t\ttry {
\t\t\tawait lstat(to);
\t\t}
\t\tcatch (error) {
\t\t\tif (error?.code === "ENOENT") exists = false;
\t\t\telse throw error;
\t\t}
\t\tif (exists) throw Object.assign(new Error(`EEXIST: file already exists, link '${from}' -> '${to}'`), { code: "EEXIST", errno: -17, syscall: "link", path: to, dest: from });
\t\tawait rename(from, to);
\t},
\trm: (path) => rm(path, { force: true })'''),
 ('\t\t\tawait link(tmp, finalPath);',
  '\t\t\tawait rename(tmp, finalPath); /* dsh-android */'),
])

# 6b-2. 附件：别名发布必须保留源对象（用排他复制）；staged 发布随后即 unlink → rename
edit(NM + '/@deepseek-ai/dsh-attachment-local/lib/index.js', [
 ('import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
  'import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";'),
 ('\t\t\tawait link(source, target);',
  '\t\t\tawait copyFile(source, target, constants.COPYFILE_EXCL); /* dsh-android: 源对象须保留 */'),
 ('\t\t\tawait link(staged.path, target);',
  '\t\t\tawait rename(staged.path, target); /* dsh-android: 紧随其后即 unlink(staged.path) */'),
])
PY

# 语法自检：补丁必须不破坏模块
for f in "$DSH_DIR/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" \
         "$DSH_DIR/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js" \
         "$DSH_DIR/node_modules/@deepseek-ai/node-addon-system/lib/flock.js"; do
  [ -f "$f" ] || continue
  node --check "$f" || { warn "  语法校验失败: $f"; exit 1; }
done
ok "  兼容补丁完成并通过语法校验"

# --------------------------------------------------------------------- 7/7 完成
info "7/7 完成 🎉"
"$WRAPPER" --version
cat <<EOF

启动：
  dsh web
然后浏览器打开日志里带 token 的地址（默认 http://127.0.0.1:3080/?token=...）。
API Key 在 Web UI 的 Models 页配置，或写入 ~/.dsh/.credentials.yaml。

说明：
  - 只装原版，不做沙箱/权限/前端适配。Android 内核不给非特权 user namespace，
    bwrap/landlock 后端不可用，workspace-write 模式下 bash 工具会拒绝执行。
    需要 bash 工具时，写入 ~/.dsh/cordis.patch.yml（home 级，覆盖所有 profile）：
        - id: permission
          config:
            defaultPreset: danger-full-access
    注意 0.2.x 起权限是 preset 体系，不要再单独覆盖 sandbox-policy 的 mode——
    （danger-full-access + ask）恰好是保留的 auto preset 组合，会导致
    permission 条目匹配不到 preset 而报 “composed sandbox and approval
    defaults match no preset”。0.1.x 老写法才是 sandbox-policy/mode。
  - 补丁内容全部列在本文件头部注释；升级 dsh 或 Node 后需重跑本脚本。
EOF
