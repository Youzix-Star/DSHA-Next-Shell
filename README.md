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

每一步的详细原因都写在 `install-dsh.sh` 的头部注释里。

## 鸣谢

特别感谢 [**FunnelCakes/deepseek-harness-android**](https://github.com/FunnelCakes/deepseek-harness-android)。

本脚本的**构建依赖清单**、**`android30` 编译目标**、**`--allow-scripts` 放行清单**以及**包装脚本方案**均来自该项目 —— 没有它作为参考，就不会有这个简化版本。原项目功能更完整（前端适配、sharp wasm 回退、启动停止脚本、大量运行时补丁），需要完整方案请直接使用它。

## 协议

[AGPL-3.0](LICENSE)
