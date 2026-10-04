# @dsha/dsh-android-fixes

把 **install-dsh.sh** 里那些「安装时直接改文件」的 Android/Termux 兼容修复，
变成一份**可检测、可开关、有说明**的 DSH 插件：设置里有独立一页，每项一个状态、
一个开关（能切的）或一份检测结论（切不了的）。

* Host 半身：`index.js` —— 补丁引擎 + 一个前缀 HTTP 路由 + 一个 `android_compat` 工具。
* Client 半身：`client.js` —— Settings → **安卓兼容** 一页。
* 锚点来源：`src/patches.js` **由 `install-dsh.sh` 生成**（见 `tools/extract-anchors.py`），
  手抄不会漂移。

---

## 修复项

### A. 可在运行时开关（`kind: patch`）

| id | 目标 | 说明 |
|---|---|---|
| `flock-session-lock` | `@deepseek-ai/node-addon-system/lib/flock.js` | 平台门禁降级为「无锁可用」（等价 0.1.x） |
| `session-log-hardlink` | `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | 发布改用 `rename`，保留原 `link` 的 `EEXIST` 语义 |
| `attachment-hardlink` | `@deepseek-ai/dsh-attachment-local/lib/index.js` | staged 发布用 `rename`；内容寻址的**别名发布必须用 `copyFile(..., COPYFILE_EXCL)`**，用 rename 会删掉源对象 |
| `app-boot-native-addon` | `dsh-app-boot/lib/index.js` + `lib/worker/profile-resolution-bootstrap.js` | 改回 `createRequire` + `--expose-internals` |
| `composer-enter` | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | 普通回车=换行，`enterkeyhint="newline"` |

每个目标文件里至少有一处带 `dsh-android` 标记。开关的实现是**精确字符串替换**：

* 开启：`upstreamText -> patchedText`；
* 关闭：`patchedText -> upstreamText`，即逐字节还原成上游内容（不是从备份恢复，
  所以即使期间 dsh 升过级也不会把文件降级）。

**锚点失配时显式失败**：任何一对锚点在文件里出现的次数不是 1，该项状态就是
`blocked`，`apply` 直接抛 `ANCHOR_MISMATCH`，**不写任何字节**；多目标项在写入前
先把所有目标的计划算完，写入中途失败会把已写的目标回滚。

### B. 安装期决定（`kind: install`，只检测）

| id | 检测依据 |
|---|---|
| `android-compile-target` | koffi / node-pty 的 android-arm64 产物存在且能在进程内加载 |
| `allow-scripts` | 同上——这些产物只在安装脚本被放行后才会出现 |
| `sharp-wasm-fallback` | `@img/sharp-wasm32` + `@emnapi` 就位且 `require('sharp')` 成功 |
| `dsh-wrapper` | `$PREFIX/bin/dsh` 的 shebang 与 `--expose-internals` |
| `node-gyp-android-ndk` | `~/.cache/node-gyp/<node>/include/node/common.gypi` 里的 `android_ndk_path` |

这两项（编译目标、`--allow-scripts`）在产物里**不留任何标记**，所以插件只能报告
「最强可用证据」而不是断言；设置页把证据原文一起显示出来，不会假装确定。

---

## 为什么「回车键」仍然是一个文件补丁

任务要求先确认客户端能不能在运行时拿到作曲区/编辑器实例。实测结论：**拿不到**。
下面是查询记录（`cordis_inspect_query`，对着当时正在运行的页面）：

* `client Service.listService`（根服务全目录）：只有 `layout`、`locale`、`sessions`、
  `slots`、`theme`、`timer`、`uiWorkspace`、`workspaces`。没有编辑器、没有作曲区服务。
* `@deepseek-ai/dsh-client-ui-conversation` 的 `client/service.d.ts` 里确实有根服务
  `ctx.conversation`（`ConversationController`）与 `ctx.uiConversation`，但
  `ConversationController.input` 是 `SessionInputResolver`；`SessionInput` 只暴露
  `setDraft` / `submit` / `focus` / `state` / `beginCommand` / `insertReference`，
  **没有光标级插入**。
* `conversation.input.dock` / `conversation.input.overlay` 的 ownerProps 是
  `{ session, input }`，标准 props 里有 `inputActions`（`captureInsertion` /
  `insertText` / `setDraft` / `submit`）。`insertText` 走的是
  `$replaceDetectSpanWithText`，插入的是「引用文本」语义，不是换行。
* Lexical 键盘映射是私有的：`registerComposerKeymap(editor, handlers)` 内部
  `editor.registerCommand(KEY_ENTER_COMMAND, ..., 4)`，editor 由 Session 持有，从不外露。
* 官方设置项 `composer-enter` 的取值域只有 `["queue", "steer"]`（忙时回车走队列还是
  插话），**没有「回车=换行」**，所以配置层也表达不了这个行为。

要纯运行时实现，只能在 document 捕获阶段拦截 Enter，再自己往 contenteditable 里塞换行
（`execCommand('insertLineBreak')`，或者重派发一个合成 keydown —— 而不可信事件不会触发
浏览器默认行为）。这条路依赖 Lexical 对 DOM 变更的再协调，属于未验证的猜测，而且
`enterkeyhint` 还必须去动宿主作曲区的 DOM。**本环境没有浏览器控制能力**（见下面的验证
限制），这种实现无法验证，所以这一项按任务允许的回退方案，由插件持有文件补丁，
并把这段调查写在这里，供将来上游暴露编辑器实例时替换成运行时钩子。

---

## 安装

在工作区里写好包之后，走官方流程（**不要**手写 profile 的 `package.json` /
`cordis.patch.yml`，也不要在 profile 目录里跑 pnpm）：

```
plugin_manager install_bundle  target: /绝对路径/DSHA-Next/dsh-android-fixes
```

返回 `application: applied` 后即生效：Settings 里出现一页，`android_compat` 工具可调用。

## 使用

### 设置页

Settings → **安卓兼容**。分组为「可在运行时开关」与「安装期决定」；每行显示名称、
说明、目标文件、状态胶囊与开关。顶部有三个按钮（重新检测 / 全部开启 / 全部关闭），
另有一项「升级 dsh 后自动重新应用已开启的修复」。

### Agent 工具

```
android_compat { "action": "status" }
android_compat { "action": "disable", "id": "flock-session-lock" }
android_compat { "action": "enable",  "id": "flock-session-lock" }
```

### HTTP（设置页用的就是它）

前缀 `/api/dsh-android-fixes`：`GET /status`、`POST /set`、`POST /set-all`、
`POST /settings`。路由套了与内核 `/api` 同一道信任栅栏（优先用 `connection.admit`，
没有该服务时退化为结构等价的本地回环 + Origin 校验）。

---

## 状态与备份

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/state/dsh-android-fixes/settings.json` | `autoReapplyOnStart` 与每项的用户意图 |
| `$DSH_HOME/state/dsh-android-fixes/backups/<包>/<文件>.<时间戳>.bak` | 每次写入前的逐字节快照（第二道保险；还原本身不依赖它） |

文件本身就是状态的真相：磁盘上有补丁 = 已应用。用户意图只用于「升级后自动重新应用」，
默认关闭。

**注意**：文件补丁不会改变当前进程里已经加载的模块，改动在重启 dsh 之后生效。

---

## 新增一项修复

1. `install-dsh.sh` 里加好步骤；
2. `tools/extract-anchors.py` 顶部的 `ENTRIES` 加一行，重新生成 `src/patches.js`
   （安装期事实则改在 `src/checks.js` 加一条 `detect`）；
3. `client.js` 的 `zh` / `en` 字典加 `item_<key>_title` / `item_<key>_desc`，
   `COPY_KEY` / `PATCH_ORDER`（或 `CHECK_ORDER`）各加一条；
4. `node scripts/check.mjs && node scripts/selftest.mjs`。

## 自测

```
node scripts/check.mjs                 # 清单 / 导出 / 无 Harness Client 依赖
node scripts/selftest.mjs              # 沙箱里跑 检测→应用→还原→锚点失配
node scripts/integration.mjs           # 只读：挂载真实 apply()，打 GET /status
node scripts/integration.mjs --mutate  # 会真的改磁盘再还原（逐字节校验）
```

`selftest` 在临时目录里重建一棵上游树，断言「应用后的字节 == 安装脚本产出的字节」、
「还原后的字节 == 上游字节」、「锚点被改动时拒绝写入且文件原样」。
`integration --mutate` 走的是插件自己的 `apply()` 与请求处理，不是复刻实现。

## 验证限制

安装所在的环境没有任何浏览器控制能力，所以**视觉验证不可用**。本包给出的验证是：
JS 语法、清单校验、真实 `apply()` 的挂载与路由响应、Client `settings.section`
注册表里该页 `active: true`、真实文件补丁的开/关逐字节校验，以及一轮真实的
`dsh headless` 对话。页面的实际观感需要人眼看一次。
