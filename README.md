# DSHA-Next-Shell

在 Android / Termux 上安装**原版** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的最小安装脚本。

不含任何功能改动：没有前端补丁、没有移动端适配、没有启动停止脚本、不改权限配置、不切镜像源。

## 用法

```sh
bash install-dsh.sh              # 安装 npm 上的 latest
bash install-dsh.sh 0.2.0-rc.2   # 安装指定版本
```

装完启动：

```sh
dsh web
```

浏览器打开日志里带 token 的地址（默认 `http://127.0.0.1:3080/?token=...`），API Key 在 Web UI 的 Models 页配置。

## 它只做必要的 Android 兼容处理

| 步骤 | 解决什么 |
|---|---|
| 构建依赖 | 只补缺失的包，**不执行 `pkg update`**（半升级会让 cmake 报 `cannot locate symbol`） |
| 修补 `common.gypi` | 定义 `android_ndk_path`，修 node-pty 的 `Undefined variable` |
| `-target aarch64-linux-android30` | bionic 在 API 30 才声明 `statx()`，否则 koffi 编译失败 |
| 重建 `dsh` 包装脚本 | npm 建的软链 shebang 是 `/usr/bin/env`，Android 无 `/usr`；且需 `--expose-internals` |
| 原生 addon 兼容 | `node-addon-require-builtin` 无 android 预编译包、包内无 C++ 源码 |
| flock / hardlink 兼容 | 会话锁无 android 原生包 → 降级为无锁；Android 禁 `link(2)`，按各自语义改用 `rename` 或排他复制 |

每一步的详细原因都写在 `install-dsh.sh` 的头部注释里。

## 鸣谢

特别感谢 [**FunnelCakes/deepseek-harness-android**](https://github.com/FunnelCakes/deepseek-harness-android)。

本脚本的**构建依赖清单**、**`android30` 编译目标**、**`--allow-scripts` 放行清单**以及**包装脚本方案**均来自该项目 —— 没有它作为参考，就不会有这个简化版本。原项目功能更完整（前端适配、sharp wasm 回退、启动停止脚本、大量运行时补丁），需要完整方案请直接使用它。

## 协议

[AGPL-3.0](LICENSE)
