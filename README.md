# TauriSSH

基于 **Tauri 2 + Ant Design 6 + React 19** 重构的跨平台 SSH 工作台，桌面端与移动端共用同一套 Rust SSH/SFTP 实现。

原项目 [WebSSH](https://github.com/szzz666/WebSSH) 采用 Java（Spark + JSch）后端加浏览器前端；本仓库把 SSH、SFTP、Screen、监控等能力全部下沉到 Rust 原生层，用 Tauri 打包成 macOS / Windows / Linux / Android / iOS 原生应用，不再需要单独运行服务端。

## 功能

- SSH 密码 / PEM / OpenSSH 私钥认证，连接前展示并确认主机指纹（SHA256）
- 基于 xterm.js 的交互式终端，PTY 尺寸同步、字号调节、自动重连
- GNU Screen 后台会话：创建、列表轮询、挂载、终止
- SFTP 文件管理：浏览、上传、下载、新建、重命名、复制、移动、删除、权限修改
- 在线文本编辑（UTF-8，≤ 2 MiB，Ctrl/Cmd+S 保存）
- 压缩解压：.tar.gz / .tgz / .zip / 单文件 .gz，异步任务 + 轮询进度
- 资源监控：CPU、内存、Swap、根分区、负载、运行时间、进程数、累计收发，含 20 次采样趋势图
- 远程桌面快捷方式（`$HOME/.webssh/desktop`）
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

`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时：

1. 创建 GitHub Release 草稿并同步版本号
2. 并行构建 macOS (Apple Silicon)、macOS (Intel)、Windows x64、Linux x64
3. 构建 Android APK（arm64 / armv7）与 AAB
4. 构建 iOS 未签名 .ipa（如需签名，配置下方的 Secrets）
5. 上传全部产物并结束草稿状态

可选 Secrets：

| Secret | 说明 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 自动更新签名密钥 |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 代码签名与公证 |
| `APPLE_MOBILE_PROVISION_PROFILE` / `KEYCHAIN_PASSWORD` | iOS 签名与描述文件 |

发布示例：

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
│  └─ components/            # 终端、文件、编辑、监控、后台、记录
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
