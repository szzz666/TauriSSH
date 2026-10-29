# TauriSSH

基于 **Tauri 2 + Ant Design 6 + React 19** 重构的跨平台 SSH 工作台，桌面端与移动端共用同一套 Rust SSH/SFTP 实现。

原项目 [WebSSH](https://github.com/szzz666/WebSSH) 采用 Java（Spark + JSch）后端加浏览器前端；本仓库把 SSH、SFTP、Screen、监控等能力全部下沉到 Rust 原生层，用 Tauri 打包成 macOS / Windows / Linux / Android / iOS 原生应用，不再需要单独运行服务端。

## 功能

- SSH 密码 / PEM / OpenSSH 私钥认证，连接前展示并确认主机指纹（SHA256）
- 基于 xterm.js 的交互式终端，PTY 尺寸同步、字号调节、自动重连
- GNU Screen 后台会话：创建、列表轮询、挂载、终止；会话图标集成在 Dock 中，不再占用独立窗口
- Dock 仅显示最小化窗口与后台 Screen 会话，减少窗口切换噪音
- 任务管理器：进程结束 / 强制结束、CPU / 内存 / 磁盘 / 网络性能曲线；统一“服务”页管理 systemd 服务与开机启动，并支持在 UI 中创建自定义服务
- 防火墙策略：支持 UFW / firewalld，默认拒绝入站、按需放行 SSH / HTTP / HTTPS 与自定义端口
- 软件源配置：阿里云、腾讯云、清华、中科大、华为云镜像一键切换，自动备份原配置
- 系统时间：chrony 安装与启停、NTP 服务器配置、立即校准、chronyc tracking，以及 timedatectl 时区设置与常用时区快捷切换
- SFTP 文件管理：浏览、上传、目录打包下载、新建、重命名、复制、移动、删除、权限修改，完整右键菜单
- 在线文本编辑（UTF-8，≤ 2 MiB，Ctrl/Cmd+S 保存）
- 压缩解压：.tar.gz / .tgz / .zip / 单文件 .gz，异步任务 + 轮询进度
- 远程桌面快捷方式（`$HOME/.webssh/desktop`）：图标可拖动、自动吸附，位置保存到服务器 `.webssh/desktop-layout.json`
- 连接配置、操作历史（最近 150 条，可筛选/复制/导出 CSV）、主题（浅色/深色/跟随系统）
- 响应式界面：≤767px 或触屏设备自动切换为移动端布局

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面/移动容器 | Tauri 2 |
| 前端 | React 19、Ant Design 6、xterm.js 6、Vite 8、TypeScript |
| SSH / SFTP | [russh](https://crates.io/crates/russh) 0.65、[russh-sftp](https://crates.io/crates/russh-sftp) 3 |
| 运行时 | tokio |

## 环境要求

- Node.js 20+ 与 npm
- Rust stable（`rustup`）
- 桌面端：macOS 需要 Xcode Command Line Tools；Linux 需要 `libwebkit2gtk-4.1-dev` 等；Windows 需要 WebView2
- Android：Android SDK + NDK 26/27、JDK 17
- iOS：Xcode + Apple 开发者账号（签名）

## 开发

```bash
npm install
npm run tauri dev          # 桌面端开发
npm run tauri android dev  # Android 调试
npm run tauri ios dev      # iOS 调试
```

## 构建

```bash
npm run tauri build                          # 桌面端安装包
npm run tauri android build --apk --target aarch64
npm run tauri ios build
```

## 测试

Rust 集成测试直接连接真实 sshd，未提供 `TEST_SSH_KEY` 时自动跳过：

```bash
# 本机启动一个测试用 sshd（端口 2222）
mkdir -p /tmp/testssh && cd /tmp/testssh
ssh-keygen -t ed25519 -f ssh_host_ed25519_key -N '' -q
ssh-keygen -t ed25519 -f id_ed25519 -N '' -q
cp id_ed25519.pub authorized_keys
cat > sshd_config <<'EOF'
Port 2222
ListenAddress 127.0.0.1
HostKey /tmp/testssh/ssh_host_ed25519_key
PidFile /tmp/testssh/sshd.pid
AuthorizedKeysFile /tmp/testssh/authorized_keys
StrictModes no
UsePAM no
PasswordAuthentication no
PubkeyAuthentication yes
Subsystem sftp /usr/libexec/sftp-server
EOF
/usr/sbin/sshd -f sshd_config -E sshd.log

# 运行测试
cd src-tauri
TEST_SSH_KEY=/tmp/testssh/id_ed25519 TEST_SSH_PORT=2222 TEST_SSH_USER=$USER \
  cargo test --test e2e -- --test-threads=1
```

Android 真机冒烟测试（与 App 共用同一套 Rust SSH 实现）：

```bash
adb -s 127.0.0.1:5555 push /tmp/testssh/id_ed25519 /data/local/tmp/tk
adb reverse tcp:2222 tcp:2222
cargo build --example android_ssh_smoke --target aarch64-linux-android --release
adb push target/aarch64-linux-android/release/examples/android_ssh_smoke /data/local/tmp/
adb shell "/data/local/tmp/android_ssh_smoke 127.0.0.1 2222 $USER /data/local/tmp/tk"
```

## 自动发布

`.github/workflows/release.yml` **每次向 `main` 提交都会自动产出六个平台的安装包并发布到 Releases**，无需手动打标签。

| 触发方式 | 版本号 | Release 类型 |
| --- | --- | --- |
| push 到 `main` | 最近标签递增补丁号 + `-<run>`，如 `v0.1.1-42` | 预发布（prerelease） |
| push `vX.Y.Z` 标签 | 标签版本，如 `v0.1.0` | 正式版 |
| 手动触发并填写版本 | 填写的版本 | 正式版 |

每次运行会并行构建并上传：

| 平台 | 产物 |
| --- | --- |
| macOS (Apple Silicon) | `.dmg` + `.app` |
| macOS (Intel) | `.dmg` + `.app` |
| Windows x64 | `.exe`（NSIS）+ `.msi` |
| Linux x64 | `.AppImage` + `.deb` |
| Android | 按 ABI 拆分的 `.apk`（arm64 / armv7）+ `.aab` |
| iOS | 未签名 `.ipa`（可自签侧载） |

版本号同时写入 `package.json`、`tauri.conf.json` 与 Android 的 `versionName` / `versionCode`（`versionCode` 取 run number，保证每次构建递增）。

预发布标识必须是纯数字（如 `0.1.1-42`）：Windows 的 WiX/MSI 只接受数字预发布标识，写 `dev.42` 会直接构建失败。

Android APK 用仓库里固定的发布密钥签名，因此**不同版本的 APK 可以互相覆盖升级**；iOS 构建与 macOS Apple Silicon 共用同一个 runner，避免额外的 macOS 排队等待。

> 提交信息里带 `[skip ci]` 或只改动 Markdown / LICENSE / .gitignore 时不会触发发布。

可选 Secrets（不配置也能出包，只是未签名）：

| Secret | 说明 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 自动更新签名密钥 |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 代码签名与公证 |
| `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | Android 发布签名；未配置时 CI 生成一次性密钥，APK 可安装但无法相互覆盖升级 |

生成 Android 密钥库并转为 Base64：

```bash
keytool -genkeypair -v -keystore release.keystore -alias taurissh \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -i release.keystore -o keystore.b64   # 写入 ANDROID_KEYSTORE_BASE64
```

手动发布正式版：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 目录结构

```text
TauriSSH/
├─ src/                      # React 前端
│  ├─ App.tsx                # 应用外壳与视图切换
│  ├─ api.ts                 # Tauri 命令封装
│  ├─ store.ts               # 设置 / 连接 / 历史持久化
│  └─ components/            # 终端、文件、编辑、任务管理器、系统运维、记录
├─ src-tauri/
│  ├─ src/ssh.rs             # SSH 连接与终端通道
│  ├─ src/sftp.rs            # SFTP 操作
│  ├─ src/remote.rs          # 远端命令、Screen、压缩解压
│  ├─ src/commands.rs        # Tauri 命令层
│  ├─ tests/e2e.rs           # 真实 sshd 集成测试
│  └─ examples/android_ssh_smoke.rs
├─ docs/legacy-spec.md       # 原 WebSSH 行为规格（重构基线）
└─ .github/workflows/release.yml
```

## 与旧版的差异

- 不再有 Java 服务端与浏览器访问入口，所有能力在应用内直接执行
- 主机指纹展示与确认流程保留，但不写入 `known_hosts`，安全性仍依赖人工核对
- 终端输出改为 base64 字节流传输，修复了原版按 8192 字节直接解码导致的多字节字符截断
- 编辑器由 Ace CDN 改为内置组件，离线可用
- 连接配置与历史仍保存在本机（WebView localStorage），不上传任何服务器

## 许可证

仓库暂未声明开源许可证。
