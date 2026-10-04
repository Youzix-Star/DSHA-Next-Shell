# DSHA-Next-Shell

在 Android / Termux 上安装**原版** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的最小安装脚本。

不含移动端/前端适配、启动停止脚本、权限配置写入或镜像切换。
唯一一处有意的行为改动是**回车键**（Android 输入法没有 Shift+Enter，默认回车会误发消息）。

## 用法

```sh
bash install-dsh.sh              # 安装 npm 上的 latest
bash install-dsh.sh 0.2.0-rc.2   # 安装指定版本
```

装完启动：

```sh
termux-wake-lock                              # 防 Android 后台回收实例
export DSH_PERMISSION_MODE=danger-full-access # Android 无沙箱后端，放开后才能用 bash 工具
dsh web
```

浏览器打开日志里带 token 的地址（默认 `http://127.0.0.1:3080/?token=...`），API Key 在 Web UI 的 Models 页配置。

> 回车键：**普通回车 = 换行**，发送请点界面上的发送按钮（或外接键盘 `Ctrl/Cmd+Enter`）。

## 它只做必要的 Android 兼容处理

| 步骤 | 解决什么 |
|---|---|
| 构建依赖 | 只补缺失的包，**不执行 `pkg update`**（半升级会让 cmake 报 `cannot locate symbol`） |
| 修补 `common.gypi` | 定义 `android_ndk_path`，修 node-pty 的 `Undefined variable` |
| `-target aarch64-linux-android30` | bionic 在 API 30 才声明 `statx()`，否则 koffi 编译失败 |
| 重建 `dsh` 包装脚本 | npm 建的软链 shebang 是 `/usr/bin/env`，Android 无 `/usr`；且需 `--expose-internals` |
| 原生 addon 兼容 | `node-addon-require-builtin` 无 android 预编译包、包内无 C++ 源码 |
| sharp WebAssembly 回退 | android-arm64 无 libvips 原生包；0.1.x 里 sharp 是静态 import，加载失败会让整棵插件树加载失败 |
| 回车键行为 | Android 输入法没有 Shift+Enter，默认「回车=发送」会误发消息；改为普通回车=换行，并设 `enterkeyhint=newline` 让输入法显示「换行」，发送走界面按钮 |
| flock / hardlink 兼容 | 会话锁无 android 原生包 → 降级为无锁；Android 禁 `link(2)`，按各自语义改用 `rename` 或排他复制 |
| 回车键行为（插件版） | 第 7、8 步的同锚点补丁现在由 [`dsh-android-fixes`](dsh-android-fixes/) 插件持有并逐项开关 |

每一步的详细原因都写在 `install-dsh.sh` 的头部注释里。

## 运行时补丁现在由插件持有

`dsh-android-fixes/` 是一个 DSH 插件包，把安装脚本里「安装时改文件」的那几项兼容修复
变成了**可检测、可开关、有说明**的注册表：Settings 里有独立一页，每项一个状态与一个
开关（能切的）或一份检测结论（切不了的）；上游代码变动导致锚点失配时明确报错，而不是
写出一个「只改了一半」的文件。

安装（走官方流程，不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```
plugin_manager install_bundle   target: <仓库路径>/dsh-android-fixes
```

细节、调查记录与自测见 [`dsh-android-fixes/README.md`](dsh-android-fixes/README.md)。

### 哪些步骤可以退役，哪些必须留给全新安装

插件**必须在 dsh 已经能跑起来之后**才能安装（`plugin_manager` 是运行时服务），
所以安装脚本里那一串「让 dsh 装得下、起得来」的步骤一个都不能删：

| 步骤 | 全新安装 | 插件接管后 |
|---|---|---|
| 1 构建依赖 / 2 `common.gypi` / 3 编译与放行清单 | 必须 | 不适用（安装期事实，插件只检测） |
| 4 `dsh` 包装脚本 | 必须 | 不适用（没有它 `dsh` 根本起不来） |
| 5 app-boot 原生 addon | 必须 | 不适用（在启动路径上，`dsh` 起不来就装不了插件） |
| 6 sharp wasm 回退 | 必须 | 不适用（要拷包，运行时做不了） |
| 7 flock / hardlink 运行时补丁 | 必须（**首次**启动就要用） | **可以退役**：插件持有同锚点的补丁，可逐项开关，并在升级 dsh 后按用户选择重新应用 |
| 8 回车键行为 | 可选 | **可以退役**：插件里是 `composer-enter` 一项，装完就能开 |

也就是说：`install-dsh.sh` 仍然是**引导程序**（bootstrap），负责把 dsh 装到能启动；
它的第 7、8 步从此只是「首次安装时先把 dsh 修到能跑」的权宜之计，之后的所有权在插件
手里。

已经装好插件、只是**重跑脚本**（例如升级 dsh 之后）时，可以显式把第 7/8 步交出去：

```sh
DSH_SKIP_RUNTIME_PATCHES=1 bash install-dsh.sh
```

这个开关**不是**一个纯布尔值：脚本会先看 `$HOME/.dsh/profiles/*/package.json` 里有没有
`dsh-android-fixes`，真找到接管方才跳过；没找到就告警，并照旧执行第 7/8 步（否则会话
日志、附件和回车键都会坏）。第 5 步在启动路径上，任何情况下都保留。

自动化回归：`bash tests/install-dsh-sandbox.sh` 在一个临时 prefix + 临时 HOME 里、用桩
替换 `dpkg/pkg/cmake/npx/npm`，真跑三遍安装脚本，断言「默认全打」「没接管方时拒绝跳过」
「有接管方时只跳过第 7/8 步」，并核对默认路径产出的字节与本机生产树完全一致。

想彻底从全新安装里删掉第 7、8 步，还得给脚本加一个「装完自动装插件」的收尾步骤 ——
但全新机器上 `~/.dsh/profiles/web` 要等第一次 `dsh web` 才存在，所以那一步不能放在
安装脚本末尾，得放在首次启动之后。

## 鸣谢

特别感谢 [**FunnelCakes/deepseek-harness-android**](https://github.com/FunnelCakes/deepseek-harness-android)。

本脚本的**构建依赖清单**、**`android30` 编译目标**、**`--allow-scripts` 放行清单**以及**包装脚本方案**均来自该项目 —— 没有它作为参考，就不会有这个简化版本。原项目功能更完整（前端适配、sharp wasm 回退、启动停止脚本、大量运行时补丁），需要完整方案请直接使用它。

## 协议

[AGPL-3.0](LICENSE)
