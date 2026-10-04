#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# DSH 最简安装脚本 — Android / Termux
# -----------------------------------------------------------------------------
# 只安装原版 @deepseek-ai/dsh：不做移动端/前端适配、不写启动停止脚本、不切镜像源、
# 不加 JS 性能补丁。唯一一处有意的行为改动是第 8 步的回车键（Android 输入法适配）。
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
#   6. sharp WebAssembly 回退（android-arm64 无 libvips 原生包）。
#      0.1.x 里 sharp 是静态 import —— 加载失败会让整棵插件树加载失败，dsh 根本
#      起不来；0.2.x 改成惰性 require，只会让图片/附件功能失败。两种都要修。
#   7. Android 运行时兼容
#      7a. flock 会话锁：node-addon-system 只有 darwin/linux 包，android 平台
#          门禁直接抛 ERR_FLOCK_UNSUPPORTED_PLATFORM，退化为无锁（等价 0.1.x）
#      7b. hardlink：Android/部分 ROM 禁 link(2)（会话日志、附件发布 EACCES）
#          → 会话日志与 staged 附件用 rename；内容寻址的别名发布必须保留源对象，
#            改用 COPYFILE_EXCL 而不是 rename（否则会删掉源对象）
#   8. 回车键行为：普通回车=换行，Ctrl/Cmd+Enter 或界面发送按钮才发送；
#      并给作曲区设 enterkeyhint=newline（Android 输入法没有 Shift+Enter）
#
# 用法：
#   bash install-dsh.sh              # 装 latest
#   bash install-dsh.sh 0.1.5-rc.3   # 装指定版本
#
# 装完建议先 termux-wake-lock 再 dsh web，否则实例会被 Android 后台回收。
# =============================================================================
set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

DSH_VERSION="${1:-latest}"
PKG="@deepseek-ai/dsh@${DSH_VERSION}"
NPM_PREFIX="${DSH_PREFIX:-$PREFIX}"          # DSH_PREFIX 仅用于测试/自定义前缀
DSH_DIR="$NPM_PREFIX/lib/node_modules/@deepseek-ai/dsh"
WRAPPER="$NPM_PREFIX/bin/dsh"

# --------------------------------------------------------------- 1/9 构建依赖
# 只补齐缺失的包，绝不执行 pkg update：只刷新索引再装个别包会造成 libc++ 半升级，
# 把已装好的 cmake/clang 变成 "CANNOT LINK EXECUTABLE ... cannot locate symbol"。
info "1/9 检查构建依赖"
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
cmake --version >/dev/null 2>&1 || die "cmake 无法运行（Termux 半升级常见故障）。请先执行 pkg upgrade 修好工具链，再重跑本脚本。"
ok "  node $(node -v) / npm $(npm -v)"

# --------------------------------------------------- 2/9 node-gyp headers 补丁
info "2/9 准备 node-gyp headers（node-pty 构建需要，约 1 分钟）"
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

# ------------------------------------------------------------------- 3/9 安装
info "3/9 安装 $PKG（含原生编译，约 2~10 分钟，请勿中断）"
CFLAGS="-target aarch64-linux-android30" CXXFLAGS="-target aarch64-linux-android30" \
  npm install -g --prefix "$NPM_PREFIX" \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  --no-fund --no-audit "$PKG"
INSTALLED="$(node -p "require('$DSH_DIR/package.json').version")"
ok "  已安装 @deepseek-ai/dsh@$INSTALLED"

# ------------------------------------------------------------ 4/9 包装脚本
info "4/9 生成 $WRAPPER"
rm -f "$WRAPPER"
cat > "$WRAPPER" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
exec node --expose-internals $DSH_DIR/lib/bin.js "\$@"
EOF
chmod +x "$WRAPPER"
ok "  包装脚本就位（含 --expose-internals）"

# -------------------------------------------------------- 5/9 原生 addon 兼容
info "5/9 app-boot 原生 addon 兼容"
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

# ------------------------------------------------------- 6/9 sharp wasm 回退
# android-arm64 没有 libvips 原生包，sharp 必然加载失败。0.1.x 里它是静态 import，
# 失败会让插件树整体加载失败 → dsh 完全起不来；0.2.x 是惰性 require，只影响图片功能。
info "6/9 sharp WebAssembly 回退"
SHARP_PKG="$DSH_DIR/node_modules/sharp"
if [ ! -d "$SHARP_PKG" ]; then
  ok "  该版本无 sharp，跳过"
elif [ -d "$DSH_DIR/node_modules/@img/sharp-wasm32" ]; then
  ok "  sharp-wasm32 已就位"
else
  SHARP_VER="$(node -p "require('$SHARP_PKG/package.json').version")"
  W="$(mktemp -d)"
  ( cd "$W" && npm init -y >/dev/null 2>&1 \
    && npm install "@img/sharp-wasm32@$SHARP_VER" --no-fund --no-audit >/dev/null 2>&1 ) \
    || warn "  sharp-wasm32 下载失败（图片/附件功能将不可用）"
  mkdir -p "$DSH_DIR/node_modules/@img"
  cp -r "$W/node_modules/@img/sharp-wasm32" "$DSH_DIR/node_modules/@img/" 2>/dev/null || true
  cp -r "$W/node_modules/@emnapi" "$DSH_DIR/node_modules/" 2>/dev/null || true
  rm -rf "$W"
  node -e "require('$SHARP_PKG')" >/dev/null 2>&1 \
    && ok "  sharp-wasm32@$SHARP_VER 已就位" \
    || warn "  sharp 仍无法加载（图片/附件功能将不可用）"
fi

# ----------------------------------------------------- 7/9 Android 运行时兼容
info "7/9 Android 运行时兼容补丁（flock / hardlink）"
python3 - "$DSH_DIR" <<'PY'
import io, os, sys

root = sys.argv[1]
NM = os.path.join(root, 'node_modules')
failures = []

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
            # 文件在、但目标代码变了：不能静默放过，否则装出来的 dsh 跑不动
            print("  !! 模式匹配 %d 次: %s" % (n, rel))
            failures.append(rel); return
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)
    print("  已修补:", rel)

# 7a. flock 会话锁：android 无原生包 → 退化为无锁（等价 0.1.x，调用方仍做 inode 比对）
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

# 7b-1. 会话日志发布：原 link 前已做存在性检查 → rename 等价
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

# 7b-2. 附件：别名发布必须保留源对象（用排他复制）；staged 发布随后即 unlink → rename
edit(NM + '/@deepseek-ai/dsh-attachment-local/lib/index.js', [
 ('import { chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";',
  'import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";'),
 ('\t\t\tawait link(source, target);',
  '\t\t\tawait copyFile(source, target, constants.COPYFILE_EXCL); /* dsh-android: 源对象须保留 */'),
 ('\t\t\tawait link(staged.path, target);',
  '\t\t\tawait rename(staged.path, target); /* dsh-android: 紧随其后即 unlink(staged.path) */'),
])

if failures:
    print("  失败的目标（上游代码可能已变，请勿直接使用本次安装）:", ", ".join(failures))
    sys.exit(1)
PY

# 语法自检：补丁必须不破坏模块
for f in "$DSH_DIR/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" \
         "$DSH_DIR/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js" \
         "$DSH_DIR/node_modules/@deepseek-ai/node-addon-system/lib/flock.js"; do
  [ -f "$f" ] || continue
  node --check "$f" || die "语法校验失败: $f"
done
ok "  兼容补丁完成并通过语法校验"

# ------------------------------------------------------- 8/9 回车键行为补丁
# Android 输入法没有 Shift+Enter；0.2.x 默认"普通回车=发送"，中文输入法/软键盘想换行就
# 误发消息。官方设置项只覆盖"忙时回车"（queue/steer），没有"回车=换行"，只能改 bundle。
# 两处改动（都在客户端 bundle 内，直接决定浏览器行为）：
#   a. Enter 处理器：非 Ctrl/Cmd 的回车 return false，交给编辑器默认行为=换行
#   b. 作曲区根节点设 enterkeyhint="newline"，让输入法把回车键显示成"换行"
# 发送改走界面发送按钮（onPrimary → keyboard.submit(..., "click")）或外接键盘 Ctrl/Cmd+Enter。
info "8/9 回车键行为补丁（普通回车=换行）"
CONV="$DSH_DIR/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"
if [ ! -f "$CONV" ]; then
  warn "  未找到会话客户端 bundle，跳过"
else
  python3 - "$CONV" <<'PY'
import io, sys
p = sys.argv[1]
lines = io.open(p, encoding='utf-8').read().split('\n')
if any('dsh-android: 普通回车' in l for l in lines):
    print("  已打过补丁"); sys.exit(0)

# a) 在 arbitrate 块之后的 4-tab preventDefault 前插入（整行相等，避免子串误匹配）
i = None
for idx, l in enumerate(lines):
    if (l == '\t\t\t\tevent?.preventDefault();' and idx >= 1 and lines[idx-1] == '\t\t\t\t}'
            and idx+1 < len(lines) and lines[idx+1] == '\t\t\t\tif (event?.repeat === true) return true;'):
        assert i is None, "锚点A不唯一"
        i = idx
if i is None:
    print("  !! 未找到 Enter 处理器锚点，上游代码可能已变"); sys.exit(1)
lines[i:i] = [
 '\t\t\t\t/* dsh-android: 普通回车=换行（不发送），Ctrl/Cmd+Enter 或界面按钮才发送 */',
 '\t\t\t\tif (event === null || !(event.ctrlKey === true || event.metaKey === true)) return false;',
]

# b) 在 rootElement = root; 之后设置输入法提示
j = None
for idx, l in enumerate(lines):
    if l == '\t\t\t\trootElement = root;':
        assert j is None, "锚点B不唯一"
        j = idx
if j is None:
    print("  !! 未找到作曲区根监听锚点"); sys.exit(1)
lines[j+1:j+1] = [
 '\t\t\t\t/* dsh-android: 让输入法回车键显示“换行”而不是“发送” */',
 '\t\t\t\troot?.setAttribute("enterkeyhint", "newline");',
]

io.open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print("  已修补 Enter 处理器 + enterkeyhint")
PY
  node --check "$CONV" || die "  会话客户端 bundle 语法校验失败"
  node -e "const s=require('fs').readFileSync('$CONV','utf8');process.exit(s.includes('dsh-android: 普通回车')&&s.includes('enterkeyhint')?0:1)" \
    || die "  补丁自检失败"
  ok "  回车键补丁完成并通过校验"
fi

# --------------------------------------------------------------------- 9/9 完成
info "9/9 完成 🎉"
"$WRAPPER" --version
node -e "require('$DSH_DIR/node_modules/sharp')" >/dev/null 2>&1 \
  && ok "sharp 可加载" || warn "sharp 不可加载（图片/附件功能受影响）"
cat <<EOF

启动：
  termux-wake-lock        # 防止 Android 后台回收实例
  dsh web
然后浏览器打开日志里带 token 的地址（默认 http://127.0.0.1:3080/?token=...）。
API Key 在 Web UI 的 Models 页配置，或写入 ~/.dsh/.credentials.yaml。

说明：
  - 只装原版，不做沙箱/权限/前端适配。Android 内核不给非特权 user namespace，
    bwrap/landlock 后端不可用，workspace-write 模式下 bash 工具会拒绝执行。
    推荐在启动前设置环境变量（0.2.x 上游支持，会同时设定 sandbox 与 approval）：
        export DSH_PERMISSION_MODE=danger-full-access
    要在配置层固定，则写 ~/.dsh/cordis.patch.yml（home 级，覆盖所有 profile）：
        - id: permission
          config:
            defaultPreset: danger-full-access
    注意：不要只覆盖 sandbox-policy 的 mode。0.2.x 的 approval 默认值由同一个环境
    变量推算，只改 sandbox 会组合出 (danger-full-access + ask) —— 恰好是保留的
    auto preset 组合，导致 permission 条目 “did not activate” 并报
    “composed sandbox and approval defaults match no preset”。
  - 上游代码变动会让第 7 步的补丁失配，此时脚本会直接失败而不是装出一个跑不动的
    dsh；遇到这种情况请换用已验证的版本。
  - 补丁内容全部列在本文件头部注释；升级 dsh 或 Node 后需重跑本脚本。
EOF
