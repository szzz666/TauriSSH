# WebSSH 现状行为规格说明（Legacy Spec）

> 本文件是对既有 Java(Spark) + 原生 Vue3 项目 `/Users/mac/IdeaProjects/WebSSH` **当前实现行为**的逐条还原，用于 TauriSSH 的等价重写/移植。
> 分析基准：git `HEAD = 52ba3364ac8d7d0fb25ae89dced7ffb459571945`（2026-10-20）。
> 原则：**路径、JSON 字段名、shell 命令字符串、错误码必须逐字照抄**；中文文案保持原文。

---

## 0. 阅读约定

| 占位符 | 含义 |
| --- | --- |
| `<Q(x)>` | 后端函数 `shellQuote(x)`：`"'" + x.replace("'", "'\"'\"'") + "'"`，即**单引号包裹并把内嵌单引号替换为 `'"'"'`** |
| `<id>` | SSH 连接 ID（服务端 `UUID.randomUUID().toString()`） |
| `<name>` | Screen 会话名，正则 `webssh-[a-f0-9]{12}` |
| `<uploadId>` | 上传任务 ID（UUID 字符串） |
| `<jobId>` | 文件任务 ID（UUID 字符串） |
| `{...}` | JSON 对象；字段顺序不代表实际序列化顺序（后端大量使用 `Map.of`，顺序不定） |

源码引用格式：`WebServer.java:369` 表示该文件第 369 行。文件均在 `src/main/java/top/szzz666/` 或 `src/main/resources/public/` 下。

---

## 1. 运行时与配置

### 1.1 技术栈（现状）

- 后端：Java 21、Spark Java 2.9.4（内嵌 Jetty）、Jetty WebSocket 注解式端点、JSch 0.1.55、Gson 2.8.9、SnakeYAML、Hutool-cron（仅工具类，未被业务使用）。
- 前端：Vue 3.5.13（从 webjar 本地提供）、Axios 1.7.8（本地提供）、xterm.js 5.3.0 + xterm-addon-fit 0.8.0（`/lib/` 本地提供）、Ace Editor 1.43.3（**运行时从 jsDelivr CDN 动态加载**）。
- 前端真正被 `index.html` 引用的是 **`/webssh.compat.js`**（`index.html:142`），它是 `webssh.js` 经 esbuild 以 `--target=chrome64` 转译后的产物；两者逻辑一致（130 个方法一一对应，仅引号风格不同）。**修改 `webssh.js` 必须重新生成 `webssh.compat.js`**：

  ```bash
  npx --yes esbuild@0.25.6 src/main/resources/public/webssh.js --outfile=src/main/resources/public/webssh.compat.js --target=chrome64 --format=iife --charset=utf8
  ```

### 1.2 配置项（`config.yml`，由 `EasyConfig` 自动生成/补全，启动时读取一次）

| key | 默认值 | 说明 | 用途 |
| --- | --- | --- | --- |
| `log.level` | `INFO` | 日志等级 | log4j2 root level |
| `settings.cordPoolSize` | `1` | 核心线程数 | 遗留线程池（业务实际使用虚拟线程） |
| `settings.maxPoolSize` | `-1` | 最大线程数 | 同上 |
| `settings.keepAliveTime` | `60` | 秒 | 同上 |
| `settings.maxQueueSize` | `100` | 队列长度 | 同上 |
| `server.host` | `127.0.0.1` | 监听地址，支持 IPv6（`::`/`::1`） | Spark `ipAddress` |
| `server.port` | `8080` | REST + WS + 静态页面共用端口 | Spark `port` |
| `ssh.connectTimeoutMs` | `15000` | SSH 建连/认证超时，也是 SFTP/Exec 通道建链超时、WebSocket shell 建链超时 | |
| `ssh.commandTimeoutMs` | `30000` | 普通 `exec` 超时（监控、screen、cat 等） | |
| `ssh.maxUploadBytes` | `1048576000`（约 1 GiB） | 单文件上传上限 | `createUpload` 校验 |
| `ssh.uploadChunkBytes` | `8388608`（8 MiB） | 单分片上限，同时下发给前端作为 `chunkSize` | |
| `ssh.uploadChunkRetries` | `3` | 下发给前端作为 `chunkRetries` | |
| `ssh.uploadIdleTimeoutMs` | `1800000`（30 min） | 未完成上传任务保留时间 | 惰性清理 |
| `ssh.fileJobTimeoutMs` | `1800000`（30 min） | 压缩/解压/工具安装/目录打包下载超时 | |

### 1.3 启动与 HTTP 公共行为（`WebServer.start()`，`WebServer.java:47-221`）

1. `Service.ignite().ipAddress(MyConfig.serverHost).port(MyConfig.serverPort)`。
2. WebSocket 注册：`/api/v1/sessions/*` → `TerminalWebSocket`；`/api/v1/tasks/*` → `TaskWebSocket`。
3. 静态资源：`staticFiles.location("/public")`，`expireTime(3600)`。
4. 全局 before：`response.type("application/json; charset=utf-8")`（**所有响应默认 JSON content-type**，具体处理器再覆盖）。
5. 全局 after（缓存头）：
   - 路径以 `/api/` 开头 → `Cache-Control: no-store`
   - 路径为 `/` 或以 `.html` 结尾 → `Cache-Control: no-cache`
6. CORS 预检：`service.options("/*")` 返回 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Headers: Content-Type`、`Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`，body 为空字符串。
7. **两个 "before 过滤器" 抢在 Spark 路由匹配前处理若干 POST/GET/PUT/DELETE 请求**（原因注释：某些 Jetty/Spark 组合下参数化 POST 路由不可靠）。被过滤器命中的请求**不会**再走 `service.xxx` 路由处理器，且**状态码可能与路由版本不同**（见 4.1 的"状态码差异"列）。这一点必须在移植时保留或在文档中显式统一。
8. 异常映射（`WebServer.java:202-207`）：
   - `ApiException` → `error(res, e.status(), e.code(), e.getMessage())`
   - `JsonSyntaxException` → `400 INVALID_JSON / "请求内容不是有效的 JSON"`
   - `Exception` → `500 INTERNAL_ERROR / "服务器内部错误"`（并记录日志）
9. notFound（`WebServer.java:208-218`）：非 `/api/` 路径先按 `"/public" + pathInfo` 尝试读 classpath 资源并返回；若路径不含 `.` 则回退返回 `/public/index.html`（`text/html; charset=utf-8`）；否则 `404 {"error":{"status":404,"code":"NOT_FOUND","message":"未找到请求的资源"}}`。
10. `POST /api/v1/connections/test` 与 `POST /api/v1/connections` 也会被过滤器捕获（`bootstrap` 分支），返回 200。
11. 关闭：`WebServer.stop()` → `ConnectionManager.closeAll()` + `service.stop()`；由 JVM shutdown hook 触发（`Main.java:15`）。

---

## 2. 功能清单（Feature Inventory）

### 2.1 连接配置管理

- 支持的字段：`host`、`port`(1-65535，默认 22)、`username`、`authMethod`(`password`|`key`)、`password`、`privateKey`、`passphrase`、`name`、`trustFingerprint`。
- **配置完全保存在浏览器 `localStorage`**，后端不落盘、不提供连接列表 API。
- IPv6 主机：前端 `normalizeHost` 去掉首尾 `[]`；展示时 `formatHost` 若含 `:` 再加回 `[]`；后端 `ConnectionManager.createSession` 也会剥掉 `[]`。
- 保存判定：`if (!settings.save) { password/privateKey/passphrase 清空 }`（`webssh.js:160`）。
- 去重键：`id` 相同，或 `(host, port, username)` 三元组相同 → 覆盖（保留原 id），否则 `unshift` 到列表头（`webssh.js:161-162`）。
- 删除配置：仅从 localStorage 移除并弹 toast "连接配置已删除"。
- 兼容旧格式：若 `webssh.connections` 为空且 `webssh.settings` 内存在合法的 `profile` 对象，则迁移为单条连接（`webssh.js:131`）。
- 合法性过滤 `safeConnection`：host/username 非空字符串、port 数值 1..65535、authMethod ∈ {password,key}，否则丢弃该条。

### 2.2 终端（主终端）

- 传输：WebSocket → 后端 `ChannelShell`（pty `xterm-256color`，初始 `120x30`）。
- 前端 xterm 选项：`convertEol:true`、`cursorBlink:true`、`fontFamily:'Consolas, "SFMono-Regular", "Liberation Mono", monospace'`、`fontSize: font(默认14)`、`lineHeight:1.35`、`scrollback:5000`、主题见 7.13。
- 打开窗口时若未连接则自动 `connectTerminal()`；已连接则 `fit()` + `sendResize()`。
- 连接成功（WS onopen）立即向终端写入一行提示：`"\r\n[webssh] terminal channel opening...\r\n"`，随后 `sendResize()` 并 `focus()`。
- 断线重连：`socket.onclose` 且 `settings.reconnect === true` 且非主动关闭（`suppressClose === false`）→ `setTimeout(connectTerminal, 1800)`。
- 主动断开（`disconnectTerminal`）：`suppressClose = true`、清 `terminalLine`、清重连定时器、关 socket。
- 工具栏：清屏、复制选中、字号 −1 / +1（范围 11..22，步进 1）、重连。
- 状态栏：`#terminal-state`（"已连接"/"未连接"）、`#terminal-size`（`"{cols} x {rows}"`）、固定文本 `UTF-8`。
- 遮罩 `#terminal-overlay`：当未连接且无 connection 时显示，含"新建连接"按钮。
- 本地历史记录：把用户输入的字符累积成 `terminalLine`，回车时写入历史（类型 `COMMAND`）。规则见 7.12。

### 2.3 Screen 后台会话

- 会话名固定 `webssh-<12位小写hex>`，**只允许该正则**（kill/attach 也会校验，非法 → `400 INVALID_SCREEN_SESSION / "Screen 会话名称无效"`）。
- 创建（`POST .../screen-sessions`）：
  - `action:"kill"` + `name` → 终止会话，返回 `{"status":"closed","name":<name>}`。
  - 否则：可选 `path`（必须绝对路径；是目录 → `400 NOT_EXECUTABLE / "目录不能直接运行"`；无任一执行位 → `400 NOT_EXECUTABLE / "文件没有执行权限"`；SFTP 无此文件 → `404 SFTP_ERROR`，其他 SFTP 错误 → `502 SFTP_ERROR`）。
  - `label`：运行文件时强制为 `baseName(path)`；否则 `safeLabel(requestedLabel)`（去控制字符、trim、空则 `"Screen"`、截断到 80 字符）。
  - `autoExit`：**缺省为 true**；`Boolean.parseBoolean(String.valueOf(value))`，即任意非 `"true"` 字符串（含 `"false"`）为 false。
  - 返回 `{"name","label","path","startedAt"}`（`path` 在未运行文件时为 `""`）。
  - 远端失败 → `422 SCREEN_START_FAILED`。
- 列表（`GET .../screen-sessions`）：`{"sessions":[{name,label,path,startedAt}]}`，按 `startedAt` 升序；空列表时清空该连接的缓存。
  - 解析 `screen -ls` 输出，正则 `(?m)\b\d+\.(webssh-[a-f0-9]{12})\b`。
  - 对内存缓存中没有的会话，读取远端 `$HOME/.webssh/screen-sessions/<name>.path` / `.label` 补全；label 为空则用 `baseName(path)`，path 也为空则用 `"Screen"`。
  - 缓存中已不在 `screen -ls` 输出中的会话会被移除。
- 前端轮询：每 **4000 ms** 调用一次列表（`screenTimer`），仅在有连接时。
- 挂载（attach）：WS 路径 `/api/v1/sessions/<id>/screen/<name>`，后端在 shell 通道里写入 `exec screen -x '<name>'\r`（字面含回车）。
- 窗口：每个会话一个独立终端窗口 + Dock 图标（首字母徽标）。最小化/关闭窗口**不终止**远端 screen；Dock 右键菜单可"退出会话"（`action:"kill"`）。
- 前端窗口关闭/最小化行为：`win.socket.close()`，重开时重新 attach。

### 2.4 SFTP 文件管理

- 列目录、进入上级、直接输入路径跳转、刷新。
- 排序：目录优先，同类按 `name.localeCompare`（`sortedFiles`）。
- 多选：单行 checkbox、全选（含 indeterminate 半选态）、Ctrl 无特殊处理（点击 checkbox 切换）。
- 显示列：名称、权限（`permissions` 字符串如 `-rw-r--r--`）、所有者（**数字 uid 字符串**）、大小（目录显示 `--`）、修改时间（`toLocaleDateString()`）。
- 操作：新建目录/文件、重命名、删除（递归）、复制、移动（= rename）、权限修改、上传、下载、压缩、解压、发送到桌面（创建远程快捷方式）。
- 内部剪贴板（`fileClipboard`）：`{connectionId, mode:'copy'|'cut', entries:[{path,name,type}]}`，**只在同一连接内可用**（`clipboardAvailable()`）。粘贴到同一路径时，目标名追加 `" - 副本"`。
- 删除/权限为**逐个串行**执行，失败逐个 toast `"<name>：<message>"`，最后 toast 成功计数。

### 2.5 上传（分片）

- 触发：工具栏/右键/空白处菜单 → `#file-upload-input`（`<input type="file" multiple>`）→ `uploadFiles(FileList)`。
- 上传目标目录 = 当前目录或条目所在目录（`entryTargetDirectory`）。
- 单个文件流程见 §8.2；同名冲突弹确认框（覆盖/跳过）。
- 进度对话框：`total` = 所有文件字节数之和，`processed` = 已完成字节 + 当前文件已确认 offset。
- 完成后：刷新文件列表 + 桌面；`finishProgress(completed === files.length ? '' : "<n> 个文件上传失败")`；若有跳过则额外 toast `"已跳过 <n> 个同名文件"`。

### 2.6 下载

- 前端用隐藏 `<a download>` 直接请求 `GET /api/v1/connections/<id>/files/download?path=...`，多选时**每 350 ms 依次触发**一个下载（`setTimeout(index*350)`）。
- 若选择中包含目录，先 `ensureRemoteTools(['tar'])`，否则中止。
- 后端：文件 → 二进制流 + `Content-Length`；目录 → 远程 `tar` 实时打包为 `.tar.gz`（见 §5.8）。

### 2.7 在线编辑

- Ace Editor 首次使用时从 CDN 动态加载 `ace.js` 与 `ext-modelist.js`（`https://cdn.jsdelivr.net/npm/ace-builds@1.43.3/src-min-noconflict`），`ace.config.set('basePath', 同前缀)`。
- 编辑器选项：`{fontSize:14, showPrintMargin:false, tabSize:2, useSoftTabs:true, wrap:false}`。
- 语法模式：`ace.require('ace/ext/modelist').getModeForPath(path).mode`。
- 保存：`Ctrl-S` / `Command-S`（`addCommand({name:'saveRemoteFile'})`），或"保存"按钮；调用 `POST .../files/operation` `{action:'write', path, content}`。
- 脏标记：`editorDirty = (editorPath && getValue() !== editorCleanValue)`；状态文本 `"未保存 · UTF-8"` / `"已保存 · UTF-8"` / `"保存中..."` / `"加载中..."`。
- 保护：切换文件前若脏 → 确认框"打开其他文件？/ 当前文件尚未保存…"；关闭窗口前若脏 → "关闭未保存的文件？"；`beforeunload` 若脏则 `preventDefault()`。
- 限制：仅 UTF-8、≤ 2 MiB、不可为目录、不可含 NUL 字节（见 §8.4）。

### 2.8 压缩 / 解压

- 压缩对话框（type `archive`）：字段"基础名称"+格式选择：
  - 多选或目录：`TAR.GZ（推荐）`（"适合目录和多文件"）、`ZIP`（"通用归档格式"）。
  - 单文件：追加 `GZIP（单文件）`（"仅压缩当前文件"）。
  - 默认值：单条目时取条目名去掉 `.tar.gz|.tgz|.zip|.gz` 后缀；多选时为 `archive`；默认格式 `tar.gz`。
  - 文件名 = `去掉后缀的输入` + `.` + 所选格式；保存到父目录。
- 解压对话框：默认目录名 = `源文件名去后缀 + "-解压"`（去后缀后为空则 `"解压内容"`），保存到源文件父目录。
- 两者都先 `ensureRemoteTools`（zip 需要 `zip`+`unzip`；gz 需要 `gzip`；tar 需要 `tar`），再 `POST .../files/operation` 拿 `jobId`，然后**每 400 ms 轮询** `GET /api/v1/file-jobs/<jobId>` 直到 `completed`/`failed`。
- 进度文案：`queued` → `"正在排队..."`，其他 → `"正在处理远程文件..."`；标题 `"正在压缩"` / `"正在解压"`；`failed` → 用 `job.error` 文案并抛错。

### 2.9 资源监控

- 窗口打开时启动轮询：加载后若无误且窗口仍可见，`setTimeout(run, 1000)`；关闭窗口 / 断开连接时 `stopMetrics()`。
- 每次保存最近 **20** 个采样点 `{cpu, memory}` 用于趋势图；`trendPoints` 生成 SVG polyline 点串（`x = index*700/(n-1)`，`y = 220 - min(100,v)*1.9`）。
- 四张卡片：处理器（逻辑核心、型号）、内存（已用/可用/总计）、交换分区（已用/总计）、根目录磁盘（已用/可用/总计）。
- 右侧"系统状态"：主机名、系统（`uname -sr`）、系统负载、运行时间、进程数、累计接收、累计发送。
- 顶栏时间轴文案 `metricsTime` 初始 `"等待数据"`，成功后 `new Date(collectedAt).toLocaleTimeString()`，失败 `"错误"`。
- 格式化：`formatBytes` 单位 B/KB/MB/GB/TB，非整数保留 1 位（<10 时 1 位、否则 0 位）；`formatUptime` 生成 `"X 天 Y 小时 Z 分钟"`。

### 2.10 桌面快捷方式（远端）

- 后端在远端 `$HOME/.webssh/desktop/` 下创建 `<安全名>.webssh-link`（JSON 文档，`chmod 0600`），目录权限 `0700`。
- 桌面列表 `GET /desktop` = 该目录的 SFTP 列表；对 `*.webssh-link` 且大小 ≤ 16 KiB 的普通文件尝试解析，若 `target` 为字符串且 `targetType` ∈ {`file`,`directory`} 则把条目改成 `type:"shortcut"`，并附加 `target`、`targetType`，`name` 去掉 `.webssh-link` 后缀。解析失败（非 JSON 等）**保持普通文件形态**。
- 与 WebSSH 桌面图标的关系：前端把远端桌面条目渲染成桌面图标（与 6 个内置应用图标同一网格），拖拽位置存 localStorage。
- 打开行为：双击（桌面端）/ 单击（`(hover:none), (pointer:coarse)` 触屏）→ 目录进文件管理器，`.sh` 走 screen 运行，其他打开编辑器。
- README 明确提示：功能主要面向 root 用户（`/root/.webssh/desktop`）。

### 2.11 后端"本地"桌面快捷方式存储（`DesktopShortcutStore`）

- 独立于远端功能：读写**运行 WebSSH 服务的主机**的 `~/.webssh/desktop-shortcuts.json`。
- `GET /api/v1/desktop-shortcuts`：文件不存在 → `[]`；内容非法 JSON → 抛 `IOException`，最终 `500 INTERNAL_ERROR`。
- `POST /api/v1/desktop-shortcuts`：请求体为**数组本身**（非包装对象），逐项校验并规范化后整体覆盖写盘（临时文件 + `ATOMIC_MOVE`，不支持时退化为 `REPLACE_EXISTING` 移动）。
- 校验规则：数组长度 ≤ 200；每项必填 `id`(≤128)、`path`(≤4096)、`host`(≤255)、`username`(≤255)、`type`(≤16，仅 `file`/`directory`)、`port`(数字 1..65535)；`name` 可选(≤255)。输出仅保留 `id,path,type,name,host,port,username`（`name` 缺失则为 `""`）。任何违规 → `400 INVALID_SHORTCUTS`。
- **注意：现状前端从未调用这两个接口**（`webssh.js` 无 `desktop-shortcuts` 引用）。移植时可选保留为兼容接口。

### 2.12 远程工具检测与安装

- 工具白名单：`screen, tar, gzip, zip, unzip`（其他 → `400 VALIDATION_ERROR / "不支持的远程工具：<t>"`）。
- 检测（`GET .../tools?tools=a,b,c`，缺省为全部 5 个）：返回 `tools`（布尔映射）、`missing`、`packageManager`、`requiresSudo`、`canInstall`，以及当有缺项且有包管理器时的 `installCommand`。
- 缺少工具时，凡是需要该工具的操作都会被前置拦截 → `409 REMOTE_TOOL_MISSING / "远程服务器缺少工具：<a, b>"`。
- 安装（`POST .../tools/install` `{"tools":[...]}`）：加连接级互斥锁；先 inspect，无缺项直接返回现状；无包管理器 → `422 PACKAGE_MANAGER_NOT_FOUND`；执行安装命令（超时 `fileJobTimeoutMs`），失败 → `422 REMOTE_TOOL_INSTALL_FAILED`；安装后复检，仍缺 → `422 REMOTE_TOOL_INSTALL_FAILED / "安装结束后仍缺少工具：…"`。
- 前端确认流程：`ensureRemoteTools(tools)` → 若 `canInstall === false` 抛 `远程服务器缺少 …，且未检测到支持的包管理器`；否则弹确认框（标题 `安装 <a / b>？`，描述 `远程服务器缺少所需命令，将执行：<installCommand>`，按钮"确认安装"），确认后显示进度对话框"正在安装远程工具"，完成后关闭。

### 2.13 服务器重启

- `POST /api/v1/connections/<id>/power`，body 必须为 `{"action":"reboot"}`（否则 `400 VALIDATION_ERROR / "action must be reboot"`）。
- 执行命令：`shutdown -r now 2>/dev/null || systemctl reboot`（通过 TaskManager 异步）。
- 返回 `{"status":"rebooting","taskId":<id>}`；状态码：路由版本 **202**，过滤器版本 **200**。
- 前端：危险确认 → 调接口 → 记录 `REBOOT` 历史 → 主动清理终端/Screen/监控/连接状态（不等待断开事件）。

### 2.14 任意远端命令任务

- `POST /api/v1/connections/<id>/tasks` `{"command":"..."}` → 202 `{"taskId","status":"running"}`。
- 命令为空 → `400 VALIDATION_ERROR / "command is required"`。
- 输出/状态通过任务 WebSocket 推送（§4.2）。**现状前端未使用此接口**（无 UI 入口）。

### 2.15 操作历史

- 记录类型（`type`）：`CONNECT, DISCONNECT, REBOOT, COMMAND, DOWNLOAD, UPLOAD, FILE OPEN, FILE RUN, FILE WRITE, FILE MKDIR, FILE CREATE, FILE RENAME, FILE COPY, FILE MOVE, FILE DELETE`。
- 展示映射（`historyType`）：连接/断开/重启服务器/命令/下载/上传/打开文件/运行文件/保存文件/新建目录/新建文件/重命名/复制/移动/删除；未知类型原样显示。
- 条目：`{time: ISO 字符串, type, value}`；持久化仅保留最近 **150** 条（`history.slice(-150)`）。
- 列表按时间倒序（`slice().reverse()`），过滤串匹配 `"<type> <value>"`（小写包含）。
- 复制：`"<formatDateTime(time)>\t<类型中文>\t<value>"` 逐行拼接。
- 导出 CSV：表头 `time,type,value`，全部字段双引号包裹、`"` 转义为 `""`，CRLF 行分隔，前置 UTF-8 BOM，文件名 `webssh-history-<Date.now()>.csv`。
- 清空：需危险确认（受 `settings.confirm` 控制）。

### 2.16 主题

三态 `system` / `light` / `dark`（默认 `system`），作用于 `html[data-theme]`；切换入口有两处（顶栏循环切换按钮、设置窗口下拉框）。终端与 Ace 编辑器主题联动，详见 §6.10。

### 2.17 移动端适配

以 `767px` 与 `(hover: none) and (pointer: coarse) and (max-width: 1024px)` 为界：窗口全屏化、图标改网格、Dock 常驻底部、菜单与弹窗改底部抽屉、隐藏最大化与内置 Dock 项。详见 §6.11。

### 2.18 其他外围行为

- 壁纸：默认 `https://www.loliapi.com/acg/`；"刷新壁纸"按视口宽度选择 `/acg/pe/?t=<ts>`（≤700px）或 `/acg/pc/?t=<ts>`；`<img onerror>` 置 `wallpaperFailed=true` → `.wallpaper-failed{display:none}`。
- 时钟：每秒刷新 `toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})`；若已连接且有 `serverTimeOffset` 则用 `Date.now()+offset` 计算。
- `syncServerTime()`：连接成功后 `GET .../time`，`offset = serverTime - Date.now()`，失败静默。
- 启动守卫：`index.html` 内联脚本在 5 s 后若 `body` 仍有 `v-cloak` 则显示 `#startup-error` 遮罩；全局 `error` 事件也会立即显示。并内置 `String.prototype.replaceAll` 与 `Promise.allSettled` 的 polyfill。Vue 挂载成功时 `mounted()` 会 `clearTimeout(window.websshStartupTimer)` 并移除遮罩。
- 会话恢复：`sessionStorage['webssh.activeConnection']` 有值且 `GET .../status` 成功 → 恢复 connection（不重连终端，除非打开终端窗口）；刷新页面时若 `navigation.type === 'reload'` 则不显示欢迎页。

---

## 3. HTTP / REST API 完整清单

### 3.0 通用约定

- 所有响应头默认 `Content-Type: application/json; charset=utf-8`（文件下载与静态资源例外）。
- **统一错误响应体**（`WebServer.error()`）：

  ```json
  {"error":{"status":<int>,"code":"<CODE>","message":"<文案>"}}
  ```

  注意 `status` 是**响应体里的数字字段**，与 HTTP 状态码同值。
- **成功响应没有统一包装**（没有 `data` 外壳），直接是业务对象/数组。
- 请求体：除特别说明外均为 JSON；解析失败 → `400 INVALID_JSON / "请求内容不是有效的 JSON"`。
- 连接不存在 → `404 CONNECTION_NOT_FOUND / "连接不存在或已过期"`；连接已断开 → `410 CONNECTION_CLOSED / "SSH 连接已关闭"`（并同时从内存中移除）。
- 前端对 `410 + CONNECTION_CLOSED` 有特殊处理：直接触发 `handleConnectionLost()`（清空所有本地会话状态并 toast `"SSH 连接已断开，请重新连接"`）。

### 3.1 端点总表（共 28 条路由）

| # | Method | Path | 说明 |
| --- | --- | --- | --- |
| 1 | POST | `/api/v1/connections/test` | 测试 SSH 认证并返回指纹 |
| 2 | POST | `/api/v1/connections` | 建立并保存 SSH 连接 |
| 3 | GET | `/api/v1/desktop-shortcuts` | 读取服务端本地快捷方式配置 |
| 4 | POST | `/api/v1/desktop-shortcuts` | 覆盖写入服务端本地快捷方式配置 |
| 5 | GET | `/api/v1/connections/:id/status` | 连接状态 |
| 6 | GET | `/api/v1/connections/:id/time` | 远端时间（毫秒） |
| 7 | DELETE | `/api/v1/connections/:id` | 断开并销毁连接 |
| 8 | GET | `/api/v1/connections/:id/files` | 列目录 |
| 9 | GET | `/api/v1/connections/:id/desktop` | 远端桌面（`$HOME/.webssh/desktop`）列表 |
| 10 | GET | `/api/v1/connections/:id/files/content` | 读取文本文件 |
| 11 | POST | `/api/v1/connections/:id/files/uploads` | 创建上传任务 |
| 12 | GET | `/api/v1/connections/:id/files/uploads/:uploadId` | 查询上传任务 |
| 13 | PUT | `/api/v1/connections/:id/files/uploads/:uploadId/chunks` | 追加分片 |
| 14 | POST | `/api/v1/connections/:id/files/uploads/:uploadId/complete` | 完成上传（原子移动） |
| 15 | DELETE | `/api/v1/connections/:id/files/uploads/:uploadId` | 取消上传 |
| 16 | GET | `/api/v1/connections/:id/files/download` | 下载文件/目录 |
| 17 | POST | `/api/v1/connections/:id/files/operation` | 文件操作总入口（11 种 action） |
| 18 | GET | `/api/v1/connections/:id/screen-sessions` | Screen 会话列表 |
| 19 | POST | `/api/v1/connections/:id/screen-sessions` | 新建/运行文件/终止 Screen 会话 |
| 20 | POST | `/api/v1/connections/:id/power` | 重启服务器 |
| 21 | GET | `/api/v1/file-jobs/:id` | 查询压缩/解压任务 |
| 22 | GET | `/api/v1/connections/:id/tools` | 检测远程工具与包管理器 |
| 23 | POST | `/api/v1/connections/:id/tools/install` | 安装远程工具 |
| 24 | GET | `/api/v1/connections/:id/metrics` | 系统指标 |
| 25 | POST | `/api/v1/connections/:id/tasks` | 起一个异步远端命令任务 |
| 26 | GET | `/vendor/vue.global.prod.js` | 本地 Vue 3.5.13 |
| 27 | GET | `/vendor/axios.min.js` | 本地 Axios 1.7.8 |
| 28 | OPTIONS | `/*` | CORS 预检 |

> 其中业务 API 25 条（#1–#25），静态资源 2 条（#26–#27），CORS 1 条（#28）。

### 3.2 逐条定义

#### 1) POST /api/v1/connections/test

请求体（`ConnectionProfile`，Gson 字段名即 JSON key）：

```json
{
  "host": "192.168.1.10",
  "port": 22,
  "username": "root",
  "authMethod": "password",
  "password": "secret",
  "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
  "passphrase": "optional",
  "name": "生产环境 A",
  "trustFingerprint": false
}
```

校验（`ConnectionManager.validate`，失败均 `400 VALIDATION_ERROR`）：

| 条件 | message |
| --- | --- |
| `host` 或 `username` 为空/空白/null | `"host and username are required"` |
| `port` < 1 或 > 65535 | `"port must be between 1 and 65535"` |
| `authMethod` 既非 `password` 也非 `key` | `"authMethod must be password or key"` |
| `authMethod == "password"` 且 `password` 空白 | `"password is required"` |
| `authMethod == "key"` 且 `privateKey` 空白 | `"privateKey is required"` |

成功 200：

```json
{
  "ok": true,
  "message": "SSH 身份验证成功",
  "fingerprint": {
    "host": "<session.getHost()>",
    "port": 22,
    "algorithm": "ssh-ed25519",
    "value": "SHA256:Base64NoPadding(SHA256(rawKeyBytes))",
    "changed": false
  }
}
```

- `fingerprint.value` 算法：`key.getKey()` 为 Base64 文本 → `Base64.getDecoder().decode()` 得到 wire bytes → `SHA-256` → `Base64.getEncoder().withoutPadding()` → 前缀 `"SHA256:"`。
- `changed` 恒为 `false`（现状没有 known_hosts 比对逻辑）。
- 指纹计算失败 → `IllegalStateException("无法计算主机指纹")` → `500 INTERNAL_ERROR`。

失败：

| HTTP | code | message |
| --- | --- | --- |
| 401 | `AUTHENTICATION_FAILED` | `"SSH 身份验证失败"`（JSch 异常文本含 `auth fail`，大小写不敏感） |
| 502 | `SSH_CONNECTION_FAILED` | JSch 原始异常文本，无则 `"SSH 连接失败"` |
| 400 | `VALIDATION_ERROR` | 见上表 |
| 400 | `INVALID_JSON` | `"请求内容不是有效的 JSON"` |

> 测试连接**永不**信任主机密钥以外的状态、不会留下会话（`finally` 里 `session.disconnect()`）。

#### 2) POST /api/v1/connections

相同请求体/校验。逻辑（`ConnectionManager.connect`）：

- 若 `trustFingerprint != true`：**先内部执行一次 test**，然后抛出
  `409 FINGERPRINT_REQUIRED`，message 拼接为：
  `"Host fingerprint confirmation is required: " + fingerprint.value`
  （例：`Host fingerprint confirmation is required: SHA256:abc...`）。该分支不会建立会话。
- `trustFingerprint == true`：建链，成功后返回 200：

```json
{
  "id": "<uuid>",
  "sessionId": "<同一个 uuid>",
  "fingerprint": {"host":"...","port":22,"algorithm":"...","value":"SHA256:...","changed":false}
}
```

- 服务端在内存 `ConcurrentHashMap` 中以 `id` 保存 `SshConnection`；日志：`"SSH 连接 {} 已建立：{}:{}，用户 {}"`。

#### 3) GET /api/v1/desktop-shortcuts

200，直接返回数组（文件不存在 → `[]`）：

```json
[{"id":"...","path":"/root/a.txt","type":"file","name":"a.txt","host":"192.168.1.10","port":22,"username":"root"}]
```

服务端文件非法 JSON → `IOException` → `500 INTERNAL_ERROR / "服务器内部错误"`。

#### 4) POST /api/v1/desktop-shortcuts

请求体 = **数组本身**（同上结构）。返回 200 + 规范化后的数组（字段顺序固定为 `id,path,type,name,host,port,username`）。
校验失败 → `400 INVALID_SHORTCUTS`，可能的 message：
`"Desktop shortcut configuration is invalid"`（JSON 结构错误）、`"Desktop shortcuts must be a JSON array"`、`"Desktop shortcut limit exceeded"`、`"Desktop shortcut is invalid"`、`"Desktop shortcut <key> is required"`、`"Desktop shortcut value is too long"`、`"Desktop shortcut type is invalid"`、`"Desktop shortcut port is invalid"`。

#### 5) GET /api/v1/connections/:id/status

200：

```json
{"id":"<uuid>","status":"connected","connectedAt":"2026-10-20T07:28:38.123Z"}
```

`connectedAt` 为 `Instant.toString()`。不存在/已断开 → 404/410（见 3.0）。

#### 6) GET /api/v1/connections/:id/time

远端执行 `date +%s%3N 2>/dev/null || date +%s000`，把输出中所有非数字字符去掉后 `Long.parseLong`。200：

```json
{"serverTime": 1760940000123}
```

解析失败会抛 `NumberFormatException` → `500 INTERNAL_ERROR`。

#### 7) DELETE /api/v1/connections/:id

`ScreenSessionManager.removeConnection(id)` → `SshConnection.close()` → 200 `{"status":"disconnected"}`。

#### 8) GET /api/v1/connections/:id/files?path=`<abs>`

Query：

- `path`：**必填非空**，缺失 → `400 VALIDATION_ERROR / "path query parameter is required"`；再做一次 `URLDecoder.decode(path, UTF-8)`。
- 使用 `sftp.ls(path)`，跳过 `.` 与 `..`。

200：

```json
{
  "path": "<sftp.realpath(path)>",
  "entries": [
    {
      "name": "app.log",
      "fileName": "app.log",
      "type": "file",
      "size": 1024,
      "permissions": "-rw-r--r--",
      "mode": "0644",
      "owner": "0",
      "modifiedAt": "2026-10-20T07:28:38Z"
    }
  ]
}
```

- `type` ∈ `directory` | `file`。
- `mode` = `String.format("%04o", permissions & 07777)`。
- `owner` = `String.valueOf(attrs.getUId())`（**数字 uid**，不解析用户名）。
- `modifiedAt` = `Instant.ofEpochSecond(mtime).toString()`。
- SFTP 异常 → `500 INTERNAL_ERROR`（**此路由未捕获 SftpException**，与 #9 不同）。

#### 9) GET /api/v1/connections/:id/desktop

无参数。先 `realpath(".")` 取 home，确保 `$HOME/.webssh` 与 `$HOME/.webssh/desktop` 存在（不存在则 `mkdir` + `chmod 0700`；若同名路径存在但不是目录 → `409 NOT_A_DIRECTORY / "<path> is not a directory"`）。

200：

```json
{
  "path": "/root/.webssh/desktop",
  "entries": [
    {"name":"a.txt","fileName":"a.txt","path":"/root/.webssh/desktop/a.txt","type":"file",
     "permissions":"-rw-r--r--","mode":"0644","size":12,"modifiedAt":"2026-10-20T07:28:38Z"},
    {"name":"项目","fileName":"项目.webssh-link","path":"/root/.webssh/desktop/项目.webssh-link",
     "type":"shortcut","target":"/root/project","targetType":"directory",
     "permissions":"-rw-------","mode":"0600","size":120,"modifiedAt":"2026-10-20T07:28:38Z"}
  ]
}
```

- shortcut 判定：普通文件 + 文件名以 `.webssh-link` 结尾 + `size <= 16384` + 内容是合法 JSON 对象且 `target` 为字符串且 `targetType` ∈ {`file`,`directory`}；否则保持普通文件（且 `name` 保留 `.webssh-link` 后缀）。
- 目录也会被列出（`type:"directory"`）。
- `SftpException`：`SSH_FX_PERMISSION_DENIED` → `403 SFTP_ERROR`；其他 → `502 SFTP_ERROR`。

#### 10) GET /api/v1/connections/:id/files/content?path=`<abs>`

200：

```json
{"path":"/root/app.conf","content":"...","size":1234,"modifiedAt":"2026-10-20T07:28:38Z"}
```

- `size` 为**实际读取字节数**；`path` 回显请求参数（不 realpath）。
- 错误：SFTP 异常（权限/不存在等）→ `500 INTERNAL_ERROR`（该路由未捕获 `SftpException`）；目录 → `400 NOT_A_FILE / "目录不能在文本编辑器中打开"`；`> 2 MiB` → `413 FILE_TOO_LARGE / "Text editor supports files up to 2 MiB"`；含 NUL → `415 BINARY_FILE / "二进制文件不能在文本编辑器中打开"`；非 UTF-8 → `415 UNSUPPORTED_ENCODING / "Only UTF-8 text files can be edited"`。

#### 11) POST /api/v1/connections/:id/files/uploads

请求体：

```json
{"path":"/root/big.iso","size":12345678,"overwrite":false}
```

- `path` 必填且必须以 `/` 开头（否则 `400 VALIDATION_ERROR / "上传路径必须是绝对路径"`）；缺失 → `"path is required"`。
- `size` 必须是非负整数（数字或数字字符串，且值等于其整数截断），否则 `400 VALIDATION_ERROR / "size 必须是非负整数"`。
- `size > maxUploadBytes` → `413 FILE_TOO_LARGE / "上传文件超过配置的大小限制"`。
- `overwrite`：仅当 JSON 值**恰好是布尔 true**（`Boolean.TRUE.equals`）才为真。

响应：

- **201** + 上传任务对象（`UploadTask.toMap()`）：

  ```json
  {"uploadId":"<uuid>","status":"uploading","path":"/root/big.iso","size":12345678,
   "offset":0,"chunkSize":8388608,"chunkRetries":3}
  ```

- 目标存在且不是目录、且 `overwrite != true` → **仍返回 201**，body 为
  `{"status":"conflict","code":"FILE_EXISTS","path":"/root/big.iso"}`（前端据此弹覆盖确认框）。
- 目标存在且是目录 → `409 INVALID_DESTINATION / "上传目标是一个目录"`。
- **幂等复用**：若已存在同 `connectionId + path + size + overwrite` 且未完成的任务，直接返回该任务状态（`status()` 会回读远端已写字节数作为 `offset`）。

#### 12) GET /api/v1/connections/:id/files/uploads/:uploadId

200：上传任务对象（同上，`offset` 为远端临时文件当前大小，`status` 为 `uploading`）。
不存在/不属于该连接 → `404 UPLOAD_NOT_FOUND / "上传任务不存在或已过期"`。

#### 13) PUT /api/v1/connections/:id/files/uploads/:uploadId/chunks?offset=`<n>`

- Query `offset` 必须匹配 `\d+`，否则 `400 VALIDATION_ERROR / "上传偏移必须是非负整数"`。
- 请求体为**原始二进制**（`application/octet-stream`），长度取 `Content-Length`：
  - `< 1` 或 `> uploadChunkBytes` → `413 CHUNK_TOO_LARGE / "上传分片超过配置的大小限制"`。
- 服务端逻辑：读取远端临时文件大小 `remoteSize`；若 `offset != remoteSize` → `409 UPLOAD_OFFSET_MISMATCH / "上传偏移不匹配，远程偏移为 <remoteSize>"`；若 `offset + contentLength > size` → `413 FILE_TOO_LARGE / "上传分片超过声明的文件大小"`；以 `ChannelSftp.APPEND` 追加写入（最多读 `contentLength` 字节）；写完回读大小，若 `!= offset + contentLength` → `502 UPLOAD_INCOMPLETE / "远程服务器未完整保存上传分片"`。
- 已完成任务再追加 → `409 UPLOAD_COMPLETED / "上传任务已经完成"`。
- 200：更新后的上传任务对象。

#### 14) POST /api/v1/connections/:id/files/uploads/:uploadId/complete

无请求体。

- 回读临时文件大小，若 `!= size` → `409 UPLOAD_INCOMPLETE / "文件尚未上传完成"`。
- 目标存在且是目录 → `409 INVALID_DESTINATION / "上传目标是一个目录"`；目标存在且 `overwrite != true` → `409 FILE_EXISTS / "目标位置已存在同名文件"`。
- 原子替换流程：`rename(path, path + ".webssh-backup-" + uploadId)` → `rename(temporary, path)`；第二步失败则回滚 `rename(backup, path)`；成功后删除备份。
- 201：

```json
{"uploadId":"<uuid>","status":"completed","path":"/root/big.iso","size":12345678}
```

- 任务从内存移除。

#### 15) DELETE /api/v1/connections/:id/files/uploads/:uploadId

删除远端临时文件（失败静默），移除任务，200 `{"status":"cancelled"}`。

#### 16) GET /api/v1/connections/:id/files/download?path=`<abs>`

- `path` 必填（同 #8 的校验与双重 URL 解码）。
- **普通文件**：`Content-Type: application/octet-stream`，
  `Content-Disposition: attachment; filename*=UTF-8''<URLEncoder.encode(baseName).replace("+","%20")>`，
  `Content-Length: <size>`，正文为 SFTP 输入流 `transferTo` 输出流。
- **目录**：要求远端有 `tar`（否则 `409 REMOTE_TOOL_MISSING`）；`Content-Type: application/gzip`，文件名 `<baseName>.tar.gz`（根目录时 `download.tar.gz`），正文为 `streamExec` 实时输出（见 §5.8）。
- 客户端断开（`IOException`）仅记日志 `"Download cancelled by client: {}"`，不报错。

#### 17) POST /api/v1/connections/:id/files/operation

公共要求：`action`、`path` 必填（`null` 时 `400 VALIDATION_ERROR / "action and path are required"`）。
成功统一 200：`{"ok":true,"action":"<action>","path":"<path>"}`（`compress`/`extract` 例外，见下）。

| action | 额外字段 | 行为 | 返回 |
| --- | --- | --- | --- |
| `mkdir` | — | `sftp.mkdir(path)` | `{ok,action,path}` |
| `create` / `write` | `content` | 以 UTF-8 覆盖写（`content` 缺失 → 空文件）；`> 2 MiB` → `413 FILE_TOO_LARGE / "Text editor supports files up to 2 MiB"` | 同上 |
| `rename` / `move` | `destination`（必填） | `sftp.rename(path, destination)` | 同上 |
| `delete` | — | 递归删除（目录：先递归删子项再 `rmdir`） | 同上 |
| `copy` | `destination`（必填） | 文件：流式 `get`→`put`；目录：`mkdir` 后递归复制（**不保留权限/时间**） | 同上 |
| `chmod` | `mode`（必填，正则 `[0-7]{3,4}`，否则 `400 VALIDATION_ERROR / "mode must contain 3 or 4 octal digits"`） | `sftp.chmod(Integer.parseInt(mode,8), path)` | 同上 |
| `desktop-shortcut` | `type`（必填，`file`/`directory`，否则 `400 VALIDATION_ERROR / "type must be file or directory"`）、`name`（可选） | 在远端桌面创建 `.webssh-link`（见 §5.11） | 同上 |
| `compress` | `destination`（必填，绝对且非 `/`）、`paths`（可选数组，1..200） | 起异步文件任务，见 §5.9 | `{"jobId":"<uuid>","status":"queued","type":"compress"}` |
| `extract` | `destination`（必填，绝对且非 `/`，`path` 也须为绝对路径） | 起异步文件任务，见 §5.10 | `{"jobId":"<uuid>","status":"queued","type":"extract"}` |
| 其他 | — | `400 UNSUPPORTED_OPERATION / "不支持的文件操作：<action>"` | — |

- `destination` 校验文案：compress → `"destination must be an absolute non-root path"`；extract → `"archive and destination must be absolute non-root paths"`。
- `paths` 数组：过滤掉 null/空白项；结果为空或 > 200 → `400 VALIDATION_ERROR / "paths must contain between 1 and 200 entries"`；未提供则退化为 `[path]`。
- `requireArchiveTool` 在入队前校验扩展名与工具：`.tar.gz`/`.tgz` → `tar`；`.zip` → 写入时 `zip`、解压时 `unzip`；`.gz` → `gzip`；其他 → `400 UNSUPPORTED_ARCHIVE_FORMAT / "压缩包必须以 .zip、.tar.gz、.tgz 或 .gz 结尾"`。
- SFTP 异常：`SSH_FX_PERMISSION_DENIED` → `403 SFTP_ERROR`；其他 → `502 SFTP_ERROR`。

#### 18) GET /api/v1/connections/:id/screen-sessions

200：

```json
{"sessions":[{"name":"webssh-a1b2c3d4e5f6","label":"app.sh","path":"/root/app.sh",
              "startedAt":"2026-10-20T07:28:38.123Z"}]}
```

需要远端 `screen`（缺失 → `409 REMOTE_TOOL_MISSING`）。`startedAt` 是**进程内首次观测时间**（不是远端真实启动时间）。

#### 19) POST /api/v1/connections/:id/screen-sessions

请求体两种形态：

```json
{"action":"kill","name":"webssh-a1b2c3d4e5f6"}
```

→ 200 `{"status":"closed","name":"webssh-a1b2c3d4e5f6"}`（需要 `screen`；非法 name → `400 INVALID_SCREEN_SESSION / "Screen 会话名称无效"`）。

```json
{"path":"/root/app.sh","label":"my-app","autoExit":true}
```

→ 200 `{"name":"webssh-xxxxxxxxxxxx","label":"app.sh","path":"/root/app.sh","startedAt":"..."}`。
`path` 省略/空 → 创建交互式 screen（`path` 返回 `""`，`label` 取 `safeLabel`）。详见 §2.3。

#### 20) POST /api/v1/connections/:id/power

```json
{"action":"reboot"}
```

- 其他值（含缺失）→ `400 VALIDATION_ERROR / "action must be reboot"`。
- 通过 `TaskManager.start(id, "shutdown -r now 2>/dev/null || systemctl reboot")` 异步执行。
- 返回 `{"status":"rebooting","taskId":"<uuid>"}`；**状态码：被 before 过滤器捕获时为 200，走路由时为 202**（现状两套逻辑并存，移植时建议统一为 202）。

#### 21) GET /api/v1/file-jobs/:id

200：

```json
{"jobId":"<uuid>","type":"compress","status":"running","processed":0,"total":0,"percent":0}
```

- `type` ∈ `compress` | `extract`；`status` ∈ `queued` | `running` | `completed` | `failed`。
- `percent` = `total <= 0 ? 0 : min(100, round(processed*100/total))`；**现状 `processed`/`total` 永远为 0**（未实现进度统计），所以 percent 恒为 0。
- `failed` 时附加 `"error":"<message>"`（默认 `"文件操作失败"`）。
- 不存在 → `404 FILE_JOB_NOT_FOUND / "文件任务不存在"`。
- 惰性清理：任务完成后超过 10 分钟，查询时顺手移除。

#### 22) GET /api/v1/connections/:id/tools?tools=screen,tar,gzip,zip,unzip

`tools` 缺省或空白 → 全部 5 个；否则按逗号分割。非法工具名 → `400 VALIDATION_ERROR / "不支持的远程工具：<t>"`；空列表 → `"工具列表不能为空"`。

200：

```json
{
  "tools": {"screen": true, "tar": true, "gzip": false, "zip": false, "unzip": false},
  "missing": ["gzip", "zip", "unzip"],
  "packageManager": "apt-get",
  "requiresSudo": true,
  "canInstall": true,
  "installCommand": "sudo -n apt-get update && sudo -n apt-get install -y gzip zip unzip"
}
```

- `installCommand` **仅当** `missing` 非空且 `packageManager` 非空时出现；`packageManager` 为 `""` 表示未找到。
- `requiresSudo` = `uid != 0`；`canInstall` = `packageManager` 非空。

#### 23) POST /api/v1/connections/:id/tools/install

```json
{"tools":["gzip","zip"]}
```

- `tools` 不是数组 → `400 VALIDATION_ERROR / "工具列表必须是数组"`。
- 返回安装后重新检测的完整结果（同 #22）。
- 错误：`422 PACKAGE_MANAGER_NOT_FOUND / "远程服务器上未找到支持的包管理器"`；`422 PACKAGE_MANAGER_NOT_FOUND / "不支持的包管理器：<m>"`；`422 REMOTE_TOOL_INSTALL_FAILED / "<stderr 或 退出码文案>"`；`422 REMOTE_TOOL_INSTALL_FAILED / "安装结束后仍缺少工具：<a, b>"`。

#### 24) GET /api/v1/connections/:id/metrics

无参数，后端执行 §5.1 的监控脚本，把 `key=value` 行解析为对象：

```json
{
  "cpu": 12.5, "memory": 43.2, "memoryTotal": 16777216000, "memoryUsed": 7247757312,
  "memoryAvailable": 9529438208, "swap": 0.0, "swapTotal": 2147483648, "swapUsed": 0,
  "disk": 61, "diskTotal": 107374182400, "diskUsed": 65502519296, "diskAvailable": 41871663104,
  "load": "0.12 0.20 0.15", "download": 123456789, "upload": 987654321, "uptime": 1234567,
  "cpuModel": "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz", "cpuCores": 8,
  "hostname": "server-01", "kernel": "Linux 5.15.0-91-generic", "processes": 213,
  "collectedAt": "2026-10-20T07:28:39.456Z"
}
```

- 数值能解析为 `Double` 就转数字，否则保留字符串（`numberOrText`）——所以 `load`、`hostname`、`kernel`、`cpuModel` 是字符串。
- `collectedAt` 由服务端 `Instant.now()` 追加。
- 命令执行失败（非 0 退出）→ `500 INTERNAL_ERROR`（`IllegalStateException`）。

#### 25) POST /api/v1/connections/:id/tasks

```json
{"command":"ls -al /root"}
```

- 202 `{"taskId":"<uuid>","status":"running"}`；空命令 → `400 VALIDATION_ERROR / "command is required"`。
- 输出经 `/api/v1/tasks/<taskId>` WebSocket 推送（§4.2）。

#### 26/27) GET /vendor/vue.global.prod.js、GET /vendor/axios.min.js

从 classpath 读取 webjar 内文件，`Content-Type: application/javascript; charset=utf-8`；读取失败返回 null（Spark 会以空体 200 结束）。

#### 28) OPTIONS /*

返回 200 空体 + 三个 CORS 头（见 §1.3）。

### 3.3 错误码全表

| HTTP | code | message（中文原文） | 触发点 |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `host and username are required` | 连接校验 |
| 400 | `VALIDATION_ERROR` | `port must be between 1 and 65535` | 连接校验 |
| 400 | `VALIDATION_ERROR` | `authMethod must be password or key` | 连接校验 |
| 400 | `VALIDATION_ERROR` | `password is required` / `privateKey is required` | 连接校验 |
| 400 | `VALIDATION_ERROR` | `path query parameter is required` | 文件列表/下载/读文件 |
| 400 | `VALIDATION_ERROR` | `path is required` | 创建上传 |
| 400 | `VALIDATION_ERROR` | `上传路径必须是绝对路径` | 创建上传 |
| 400 | `VALIDATION_ERROR` | `size 必须是非负整数` | 创建上传 |
| 400 | `VALIDATION_ERROR` | `上传偏移必须是非负整数` | 分片上传 |
| 400 | `VALIDATION_ERROR` | `action and path are required` | 文件操作 |
| 400 | `VALIDATION_ERROR` | `destination must be an absolute non-root path` | 压缩 |
| 400 | `VALIDATION_ERROR` | `archive and destination must be absolute non-root paths` | 解压 |
| 400 | `VALIDATION_ERROR` | `mode must contain 3 or 4 octal digits` | chmod |
| 400 | `VALIDATION_ERROR` | `type must be file or directory` | 桌面快捷方式 |
| 400 | `VALIDATION_ERROR` | `paths must contain between 1 and 200 entries` | 压缩多选 |
| 400 | `VALIDATION_ERROR` | `path must be absolute` | screen 运行 |
| 400 | `VALIDATION_ERROR` | `action must be reboot` | 重启 |
| 400 | `VALIDATION_ERROR` | `工具列表必须是数组` / `工具列表不能为空` / `不支持的远程工具：<t>` | 工具 |
| 400 | `VALIDATION_ERROR` | `command is required` | 任务 |
| 400 | `INVALID_JSON` | `请求内容不是有效的 JSON` | 任何 JSON 解析失败 |
| 400 | `INVALID_SHORTCUTS` | 见 #4 | 本地快捷方式 |
| 400 | `UNSUPPORTED_OPERATION` | `不支持的文件操作：<action>` | 文件操作 |
| 400 | `UNSUPPORTED_ARCHIVE_FORMAT` | `压缩包必须以 .zip、.tar.gz、.tgz 或 .gz 结尾` | 压缩/解压 |
| 400 | `INVALID_ARCHIVE` | `压缩包中包含绝对路径` / `压缩包中包含不安全路径` / `压缩包中包含符号链接或硬链接` / `GZIP 文件没有有效的输出文件名` | 解压 |
| 400 | `GZIP_REQUIRES_FILE` | `GZIP 只能压缩单个文件` / `GZIP 不支持压缩目录` | 压缩为 .gz |
| 400 | `NOT_EXECUTABLE` | `目录不能直接运行` / `文件没有执行权限` | screen 运行 |
| 400 | `NOT_A_FILE` | `目录不能在文本编辑器中打开` | 读文本 |
| 400 | `INVALID_SCREEN_SESSION` | `Screen 会话名称无效` | screen |
| 400 | `INVALID_WEBSOCKET_PATH` | `不支持的终端 WebSocket 路径` / `缺少会话标识符` | 终端 WS |
| 401 | `AUTHENTICATION_FAILED` | `SSH 身份验证失败` | 连接/测试 |
| 403 | `SFTP_ERROR` | SFTP 原始消息 | desktop / 文件操作（权限拒绝） |
| 404 | `CONNECTION_NOT_FOUND` | `连接不存在或已过期` | 所有 :id 路由 |
| 404 | `UPLOAD_NOT_FOUND` | `上传任务不存在或已过期` | 上传 |
| 404 | `FILE_JOB_NOT_FOUND` | `文件任务不存在` | 文件任务 |
| 404 | `TASK_NOT_FOUND` | `任务不存在` | 任务 |
| 404 | `SFTP_ERROR` | SFTP 原始消息 | screen 运行（目标不存在） |
| 404 | `NOT_FOUND` | `未找到请求的资源` | 未匹配路由 |
| 409 | `FINGERPRINT_REQUIRED` | `Host fingerprint confirmation is required: <SHA256:...>` | 建连 |
| 409 | `REMOTE_TOOL_MISSING` | `远程服务器缺少工具：<a, b>` | 各功能前置 |
| 409 | `INVALID_DESTINATION` | `上传目标是一个目录` / `压缩包目标不能覆盖源文件` | 上传/压缩 |
| 409 | `FILE_EXISTS` | `目标位置已存在同名文件` | 完成上传 |
| 409 | `UPLOAD_COMPLETED` | `上传任务已经完成` | 分片上传 |
| 409 | `UPLOAD_OFFSET_MISMATCH` | `上传偏移不匹配，远程偏移为 <n>` | 分片上传 |
| 409 | `UPLOAD_INCOMPLETE` | `文件尚未上传完成` | 完成上传 |
| 409 | `NOT_A_DIRECTORY` | `<path> is not a directory` | 桌面目录初始化 |
| 410 | `CONNECTION_CLOSED` | `SSH 连接已关闭` | 所有 :id 路由 |
| 413 | `FILE_TOO_LARGE` | `上传文件超过配置的大小限制` / `Text editor supports files up to 2 MiB` / `上传分片超过声明的文件大小` | 上传/编辑 |
| 413 | `CHUNK_TOO_LARGE` | `上传分片超过配置的大小限制` | 分片上传 |
| 413 | `ARCHIVE_TOO_LARGE` | `压缩包包含的条目过多` / `Extracted content exceeds 2 GiB` | 解压 |
| 415 | `BINARY_FILE` | `二进制文件不能在文本编辑器中打开` | 读文本 |
| 415 | `UNSUPPORTED_ENCODING` | `Only UTF-8 text files can be edited` | 读文本 |
| 422 | `SCREEN_START_FAILED` | 远程 stderr | 创建 screen |
| 422 | `PACKAGE_MANAGER_NOT_FOUND` | `远程服务器上未找到支持的包管理器` / `不支持的包管理器：<m>` | 工具安装 |
| 422 | `REMOTE_TOOL_INSTALL_FAILED` | 远程 stderr / `安装结束后仍缺少工具：<a, b>` | 工具安装 |
| 500 | `INTERNAL_ERROR` | `服务器内部错误` | 未捕获异常 |
| 502 | `SSH_CONNECTION_FAILED` | JSch 原始消息 | 连接/测试 |
| 502 | `SFTP_ERROR` | SFTP 原始消息 | desktop / 文件操作（其他错误） |
| 502 | `UPLOAD_INCOMPLETE` | `远程服务器未完整保存上传分片` | 分片上传 |
| 502 | `REMOTE_OPERATION_FAILED` | `远程操作失败` 或异常消息 | 仅 GET screen-sessions / GET 上传状态 / PUT 分片 / DELETE 上传 的兼容过滤器兜底 |

---

## 4. WebSocket 协议

服务端在 Spark 上注册了两条 WebSocket 路径（`WebServer.java:49-50`）：

| 用途 | 注册模式 | 实际连接路径 | 端点类 |
| --- | --- | --- | --- |
| 终端 | `/api/v1/sessions/*` | `/api/v1/sessions/<id>/terminal` 或 `/api/v1/sessions/<id>/screen/<name>` | `TerminalWebSocket` |
| 任务输出 | `/api/v1/tasks/*` | `/api/v1/tasks/<taskId>` | `TaskWebSocket` |

**没有**独立的 binary 通道；**所有帧都是文本帧，内容为 UTF-8 JSON**。服务端只实现 `@OnWebSocketMessage String`，没有 `byte[]` 处理器，客户端发二进制帧会导致连接被终止（Jetty 行为）。**移植时应显式拒绝二进制帧并回一条 error 帧。**

### 4.1 终端 WebSocket

#### 4.1.1 连接与鉴权

- URL：`ws(s)://<host>/api/v1/sessions/<id>/terminal`（主终端）、`ws(s)://<host>/api/v1/sessions/<id>/screen/<name>`（Screen 挂载）。
  - 前端 `wsUrl(id, screenName)`：`scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'`；`endpoint = screenName ? "screen/" + encodeURIComponent(screenName) : 'terminal'`；路径段 `encodeURIComponent(id)`。
- 无鉴权、无 token、无子协议协商、无 cookie 校验。
- `@WebSocket(maxTextMessageSize = 1024 * 1024)`（1 MiB）。
- 路径正则：`/api/v1/sessions/[^/]+/(terminal|screen/webssh-[a-f0-9]{12})`。不匹配 → 发 `{"type":"error","code":"INVALID_WEBSOCKET_PATH","message":"不支持的终端 WebSocket 路径"}`，然后 `close(4004, "INVALID_WEBSOCKET_PATH")`。
- `id` 不存在/已断开 → `{"type":"error","code":"CONNECTION_NOT_FOUND"|"CONNECTION_CLOSED","message":"..."}` + `close(4004, <code>)`。
- 路径段解析：把 path 按 `/` 切分，找到等于 `sessions`/`screen`/`tasks` 的段，取其后一段（`pathValue`）。

#### 4.1.2 建链序列（`TerminalWebSocket.onConnect`）

1. `ConnectionManager.require(id)`。
2. `session.openChannel("shell")` → `ChannelShell`。
3. `shell.setPtyType("xterm-256color")`，`shell.setPtySize(120, 30, 0, 0)`。
4. **先**取 `getInputStream()` 与 `getOutputStream()`，**再** `shell.connect(connectTimeoutMs)`。
5. 若路径含 `screen` 段：`RemoteToolManager.require(id, "screen")`（缺工具 → error 帧 + 4004），随后向 shell 输入流写入 `exec screen -x '<name>'\r` 并 flush。
6. 发送首帧：`{"type":"status","message":"connected"}`。
7. 启动虚拟线程 `ssh-terminal-<id>` 执行 `pump()`：8 KiB 缓冲读取远端输出，每读到即 `send({"type":"output","data":...})`（UTF-8 解码）。

#### 4.1.3 服务端 → 客户端帧

| 帧 | 触发时机 | 备注 |
| --- | --- | --- |
| `{"type":"status","message":"connected"}` | 建链成功 | 仅一次 |
| `{"type":"output","data":"<文本>"}` | 远端有输出 | 每 8192 字节一段；**多字节 UTF-8 字符可能被切断**（未做增量解码），移植时建议保留原样或改为增量解码 |
| `{"type":"status","message":"closed"}` | 远端输出流 EOF | 之后服务端 `shell.disconnect()` |
| `{"type":"error","message":"终端数据流已关闭"}` | pump 抛异常且 socket 仍 open | 不主动关 socket |
| `{"type":"error","message":"SSH 终端操作失败"}` | 建链时非 ApiException | 随后 `close(1011, "无法打开 SSH 终端")` |
| `{"type":"error","code":"<CODE>","message":"<msg>"}` | 建链时 ApiException | 随后 `close(4004, <CODE>)` |
| `{"type":"error","message":"<safeMessage>"}` | 处理客户端消息抛异常 | `safeMessage` = ApiException 的 message，否则固定 `"SSH 终端操作失败"` |

序列化：`JsonUtil.toCompactJson`（Gson：禁用 HTML 转义、序列化 null）。`Map.of` 字段顺序不保证。

#### 4.1.4 客户端 → 服务端帧

只有两种有效 `type`，其他类型被**静默忽略**（不报错，不回复）：

```json
{"type":"input","data":"ls -al\r"}
```

- `data` 为字符串，UTF-8 编码写入 shell 输入流后 flush；`data` 缺失 → 写 0 字节（仍 flush）。
- `input == null`（尚未就绪）→ `IllegalStateException("终端尚未就绪")` → 回 `{"type":"error","message":"SSH 终端操作失败"}`。

```json
{"type":"resize","cols":120,"rows":30}
```

- `cols`/`rows` 用 `getAsInt()`（缺失 → 异常 → error 帧）；取值 `Math.max(1, v)`；调用 `shell.setPtySize(cols, rows, 0, 0)`。
- `shell == null` 时静默忽略。

#### 4.1.5 关闭语义

| 场景 | close code | reason |
| --- | --- | --- |
| 正常关闭 | 1000 | — |
| 路径非法/连接不存在/缺工具 | 4004 | 错误码字符串 |
| 建链异常 | 1011 | `"无法打开 SSH 终端"` |

客户端 `onClose` 与 `onError` 都会 `shell.disconnect()`（只关通道，不影响底层 SSH Session）。

### 4.2 任务 WebSocket（远端命令输出广播）

- URL：`ws(s)://<host>/api/v1/tasks/<taskId>`（路径段名 `tasks`）。
- 连接时 `TaskManager.require(taskId)`：不存在 → `close(1008, "任务不存在")`。
- **服务端没有消息处理器**：客户端发送的任何帧都被忽略。这是单向只读通道。
- 服务端帧（每帧都含 `taskId`）：

| 帧 | 说明 |
| --- | --- |
| `{"type":"output","data":"<增量文本>","taskId":"<id>"}` | 每次 `read()`（缓冲 8192 字节）后发一帧 |
| `{"type":"status","data":"completed:<exitCode>","taskId":"<id>"}` | 命令正常结束（携带退出码） |
| `{"type":"error","data":"远程任务执行失败","taskId":"<id>"}` | 执行异常 |

- **订阅语义**：`subscribe(session)` 时先把历史输出合并成**一帧** `output` 回放；若任务已 `done`，再补发 `{"type":"status","data":"completed","taskId":"<id>"}`（注意回放状态**不带退出码**，与实时状态帧的 `completed:<code>` 不同）。
- **单订阅者**：`subscriber` 为单值字段，新连接覆盖旧连接（旧连接不再收到数据，但不会被关闭）。
- 任务不从内存移除（无 TTL），服务端重启即丢失。
- 任务执行细节：`ChannelExec`，`channel.setInputStream(null)`，`channel.setErrStream(channel.getOutputStream())` —— **stderr 合并进 stdout**，因此 `output` 帧里既有 stdout 也有 stderr。

---

## 5. 后端在远端执行的 shell 命令（逐字）

> 全部通过 `ChannelExec` 以登录用户身份执行。`<Q(x)>` 见 §0（单引号包裹 + 内嵌单引号转 `'"'"'`）。

### 5.1 系统指标（`GET /metrics`，`WebServer.java:445-458`）

```sh
LC_ALL=C; export LC_ALL; cpu1=$(awk '/^cpu /{idle=$5+$6; total=$2+$3+$4+idle+$7+$8+$9; print idle,total}' /proc/stat); sleep 1; cpu2=$(awk '/^cpu /{idle=$5+$6; total=$2+$3+$4+idle+$7+$8+$9; print idle,total}' /proc/stat); set -- $cpu1; idle1=$1; total1=$2; set -- $cpu2; idle2=$1; total2=$2; awk -v i1=$idle1 -v t1=$total1 -v i2=$idle2 -v t2=$total2 'BEGIN{dt=t2-t1; printf "cpu=%.1f\n",dt ? 100*(1-(i2-i1)/dt) : 0}'; free -b | awk '/^Mem:/{printf "memory=%.1f\nmemoryTotal=%.0f\nmemoryUsed=%.0f\nmemoryAvailable=%.0f\n",$2?100*$3/$2:0,$2,$3,$7} /^Swap:/{printf "swap=%.1f\nswapTotal=%.0f\nswapUsed=%.0f\n",$2?100*$3/$2:0,$2,$3}'; df -PB1 / | awk 'NR==2{gsub(/%/,"",$5); print "disk="$5"\ndiskTotal="$2"\ndiskUsed="$3"\ndiskAvailable="$4}'; awk '{print "load="$1" "$2" "$3}' /proc/loadavg; awk 'NR>2{rx+=$2;tx+=$10} END{print "download="rx"\nupload="tx}' /proc/net/dev; awk '{print "uptime="int($1)}' /proc/uptime; awk -F: '/^model name/{gsub(/^[ \t]+/,"",$2); print "cpuModel="$2; exit}' /proc/cpuinfo; awk '/^processor/{n++} END{print "cpuCores="n}' /proc/cpuinfo; printf 'hostname='; hostname; printf 'kernel='; uname -sr; printf 'processes='; ps -e 2>/dev/null | awk 'NR>1{n++} END{print n+0}'
```

- 输出形如：`cpu=12.5` / `memory=43.2` / `memoryTotal=16777216000` / … / `hostname=server-01` / `kernel=Linux 5.15.0` / `processes=213`，每行一个 `key=value`。
- 解析：按行取**第一个** `=` 分割；值能 `Double.parseDouble` 就转数字，否则保留字符串。
- 脚本含 `sleep 1`；该请求天然耗时 ≥1 s，超时用 `commandTimeoutMs`。

### 5.2 远端时间

```sh
date +%s%3N 2>/dev/null || date +%s000
```

输出经 `replaceAll("[^0-9]","")` 后 `Long.parseLong`。

### 5.3 重启服务器

```sh
shutdown -r now 2>/dev/null || systemctl reboot
```

### 5.4 远程工具检测（`RemoteToolManager.inspect`）

拼接规则（工具按请求顺序，去重后）：

```sh
printf 'uid=%s\n' "$(id -u)"; command -v <tool1> >/dev/null 2>&1 && echo '<tool1>=1' || echo '<tool1>=0'; command -v <tool2> >/dev/null 2>&1 && echo '<tool2>=1' || echo '<tool2>=0'; for p in apt-get dnf yum apk pacman zypper; do command -v $p >/dev/null 2>&1 && { echo manager=$p; break; }; done
```

- 注意 `for p ...` 片段源码里以**一个前导空格**开头（`" for p in ..."`），紧接在最后一个 `;` 之后。
- 解析：`uid` → `requiresSudo = (uid != "0")`；`<tool>=1|0` → `tools` 布尔表；`manager` → `packageManager`（缺失为 `""`）。

### 5.5 包管理器安装（`RemoteToolManager.installCommand`）

变量：`<prefix> = sudo ? "sudo -n " : ""`；`<packages> = String.join(" ", tools)`。

| manager | 命令（逐字） |
| --- | --- |
| `apt-get` | `<prefix>apt-get update && <prefix>apt-get install -y <packages>` |
| `dnf` | `<prefix>dnf install -y <packages>` |
| `yum` | `<prefix>yum install -y <packages>` |
| `apk` | `<prefix>apk add --no-cache <packages>` |
| `pacman` | `<prefix>pacman -Sy --noconfirm <packages>` |
| `zypper` | `<prefix>zypper --non-interactive install <packages>` |

非 root + apt + 缺 `gzip zip` 时生成：

```sh
sudo -n apt-get update && sudo -n apt-get install -y gzip zip
```

### 5.6 Screen 会话创建（超时 **1500 ms**）

内部脚本 `script`：

- 运行文件（`path` 非空）：

```sh
cd <Q(parentPath(path))> && <Q(path)>; status=$?; printf '\n[webssh] program exited with status: %s\n' "$status"; <tail>
```

  `<tail>` = `exit "$status"`（`autoExit` 为 true，**缺省即 true**）或 `exec "${SHELL:-/bin/sh}" -l`（false）。
- 不运行文件：`<tail2>` = `exec "${SHELL:-/bin/sh}" -l`

外层命令（`<name>` = `webssh-` + 12 位小写 hex；`<pathOrEmpty>` = 运行文件时的 path，否则空串）：

```sh
mkdir -p "$HOME/.webssh/screen-sessions" && printf '%s' <Q(pathOrEmpty)> > "$HOME/.webssh/screen-sessions/<name>.path" && printf '%s' <Q(label)> > "$HOME/.webssh/screen-sessions/<name>.label" && screen -DmS <Q(name)> sh -lc <Q(script)> </dev/null >/dev/null 2>&1
```

- 失败/超时后**兜底判定**：执行 `screen -ls 2>/dev/null || true`，若输出 `contains("." + name)` 视为成功，否则抛出原异常 → `422 SCREEN_START_FAILED`。（原因：部分 SSH 服务端会因 detached 子进程而保持 exec 通道不关闭。）

### 5.7 Screen 列表 / 元数据 / 挂载 / 终止

```sh
screen -ls 2>/dev/null || true
```

```sh
cat "$HOME/.webssh/screen-sessions/<name>.path" 2>/dev/null || true
```

```sh
cat "$HOME/.webssh/screen-sessions/<name>.label" 2>/dev/null || true
```

挂载（写入 shell 通道，末尾是**真实回车 `\r`**，不是字面量）：

```sh
exec screen -x <Q(name)>
```

终止：

```sh
screen -S <Q(name)> -X quit 2>/dev/null || true; rm -f "$HOME/.webssh/screen-sessions/<name>.path" "$HOME/.webssh/screen-sessions/<name>.label"
```

`screen -ls` 解析正则：`(?m)\b\d+\.(webssh-[a-f0-9]{12})\b`。

### 5.8 目录打包下载（`GET /files/download` 且 path 是目录）

```sh
tar -czf - -C <Q(parentPath(path))> <Q(sourceName)>
```

- `sourceName` = `"./" + baseName(path)`；若 `baseName` 为空（path 以 `/` 结尾）→ `sourceName = "."`，下载名 `download.tar.gz`。
- 输出经 `streamExec`（64 KiB 缓冲）直接写 HTTP 响应，超时 `fileJobTimeoutMs`。
- 需要远端 `tar`，缺失 → `409 REMOTE_TOOL_MISSING`。

### 5.9 压缩（`FileJobManager.startCompress`）

前置校验：

- `sources.contains(destination)` → `409 INVALID_DESTINATION / "压缩包目标不能覆盖源文件"`。
- 每个 source 必须 `startsWith("/")` 且 `baseName` 非空 → 否则 `400 VALIDATION_ERROR / "压缩源必须是绝对路径且不能是文件系统根目录"`。

**TAR.GZ / TGZ**（需 `tar`）：

```sh
set -e; rm -f <Q(destination)>; tar -czf <Q(destination)> -C <Q(parent1)> <Q("./"+base1)> -C <Q(parent2)> <Q("./"+base2)>
```

**ZIP**（需 `zip`；注意每个 source 一个子 shell，末尾多一个 `;`）：

```sh
set -e; rm -f <Q(destination)>; (cd <Q(parent1)> && zip -rq <Q(destination)> <Q("./"+base1)>); (cd <Q(parent2)> && zip -rq <Q(destination)> <Q("./"+base2)>);
```

**GZ**（需 `gzip`；必须单文件且非目录）：

```sh
set -e; rm -f <Q(destination)>; gzip -c -- <Q(source)> > <Q(destination)>
```

失败兜底：`rm -f <Q(destination)>`（忽略其自身异常）。
扩展名不支持 → `400 UNSUPPORTED_ARCHIVE_FORMAT / "压缩包必须以 .zip、.tar.gz、.tgz 或 .gz 结尾"`。
`.gz` 且 sources.size() != 1 → `400 GZIP_REQUIRES_FILE / "GZIP 只能压缩单个文件"`；源是目录 → `400 GZIP_REQUIRES_FILE / "GZIP 不支持压缩目录"`。

### 5.10 解压（`FileJobManager.startExtract`）

**探查命令**：

.tar.gz / .tgz（需 `tar`）：

```sh
tar -tzf <Q(archive)>
tar -tvzf <Q(archive)> | awk '{ total += $3 } END { print total+0 }'
tar -tvzf <Q(archive)> | awk '$1 ~ /^[lh]/ { exit 1 }'
tar -xzf <Q(archive)> -C 
```

.zip（需 `unzip`）：

```sh
unzip -Z1 <Q(archive)>
unzip -l <Q(archive)> | awk 'NR>3 && $1 ~ /^[0-9]+$/ { previous=current; current=$1; total += $1 } END { print total-current }'
unzip -Z -l <Q(archive)> | awk '$1 ~ /^l/ { exit 1 }'
unzip -oq <Q(archive)> -d 
```

> 注意后两条 `-C ` 与 `-d ` 之后**带尾随空格**，随后拼接 `<Q(temporary)>`。

**条目校验**（对 list 输出逐行）：空行跳过；计数 > 10000 → `413 ARCHIVE_TOO_LARGE / "压缩包包含的条目过多"`；把反斜杠统一成 `/`；以 `/` 开头或匹配 `^[A-Za-z]:.*` → `400 INVALID_ARCHIVE / "压缩包中包含绝对路径"`；任一分段等于 `..` 或含 NUL → `400 INVALID_ARCHIVE / "压缩包中包含不安全路径"`。
**链接检查**：命令非 0 退出 → `400 INVALID_ARCHIVE / "压缩包中包含符号链接或硬链接"`。
**声明大小**：`Long.parseLong(trim)` > `2 GiB` → `413 ARCHIVE_TOO_LARGE / "Extracted content exceeds 2 GiB"`。

**主解压命令**（`temporary = destination + ".webssh-extract-" + UUID`）：

```sh
set -e; rm -rf <Q(temporary)>; mkdir -p <Q(temporary)>; <extract><Q(temporary)>; test "$(du -sk <Q(temporary)> | awk '{print $1}')" -le 2097152; if [ -e <Q(destination)> ]; then cp -a <Q(temporary)>/. <Q(destination)>/; rm -rf <Q(temporary)>; else mv <Q(temporary)> <Q(destination)>; fi
```

- `2097152` = `MAX_EXTRACTED_BYTES / 1024`（KiB 单位）。
- `<extract>` = `tar -xzf <Q(archive)> -C ` 或 `unzip -oq <Q(archive)> -d `。
- 失败兜底：`rm -rf <Q(temporary)>`。

**单文件 GZIP**（`extractGzip`，需 `gzip`）：

- 输出文件名 = `baseName(archive)` 去掉末尾 3 字符；为空 → `400 INVALID_ARCHIVE / "GZIP 文件没有有效的输出文件名"`。
- `target = <destination>/<filename>`，`temporary = target + ".webssh-extract-" + UUID`。

```sh
set -e; gzip -t -- <Q(archive)>; mkdir -p <Q(destination)>; rm -f <Q(temporary)>; gzip -dc -- <Q(archive)> | head -c 2147483649 > <Q(temporary)>; test "$(wc -c < <Q(temporary)>)" -le 2147483648; mv -f <Q(temporary)> <Q(target)>
```

- `2147483649` = `MAX_EXTRACTED_BYTES + 1`，`2147483648` = `MAX_EXTRACTED_BYTES`。
- 失败兜底：`rm -f <Q(temporary)>`。

### 5.11 远端桌面快捷方式（纯 SFTP，无 shell）

- 目录：`realpath(".")` → `$HOME`；`$HOME/.webssh`、`$HOME/.webssh/desktop`；新建时 `chmod 0700`；路径已存在但不是目录 → `409 NOT_A_DIRECTORY / "<path> is not a directory"`。
- 文件名 = `safeDesktopName(name) + ".webssh-link"`。
  `safeDesktopName`：把 `[\x00-\x1f/\\]` 全部替换成 `_`，再 trim；若为 `.`、`..` 或空白 → `"shortcut"`；长度 > 200 → 截断到 200。
  `name` = 请求 `name` trim 后非空则用之，否则 `baseName(target)`。
- 写入内容（`toCompactJson`，键顺序 version→kind→name→target→targetType，逐字）：

```json
{"version":1,"kind":"remote-shortcut","name":"<name>","target":"<path>","targetType":"file|directory"}
```

- 写入后 `chmod 0600`。

---

## 6. 前端结构

### 6.1 技术形态

- 单文件 Vue 3 应用：模板写在 `index.html`（非 SFC），逻辑在 `webssh.js`（实际加载 `webssh.compat.js`），`Vue.createApp({...}).mount('body')`。
- 样式：`webssh.css`（布局/组件）、`theme.css`（`data-theme` 双主题变量覆盖）、`mobile.css`（移动端外壳，按媒体查询条件加载）、`lib/xterm.css`。
- 全局依赖：`window.Terminal`、`window.FitAddon.FitAddon`、`window.ace`、`axios`、`Vue`。
- HTTP 封装 `api(url, {method,data,params,headers,responseType,onUploadProgress})`：返回 `response.data`；异常转成 `Error`，附 `.status`、`.code`、`.data`；对 `410 + CONNECTION_CLOSED` 立即调用 `handleConnectionLost()`。

### 6.2 界面区域总览

| 区域 | DOM 根 | 内容 |
| --- | --- | --- |
| 壁纸 | `#desktop > img.desktop-wallpaper` | 外部图源，error 时加 `.wallpaper-failed`（display:none） |
| 顶栏 `.topbar` | `#brand-button` 品牌按钮（开开始菜单）、`#host-label` 主机标签、`#connection-pill` 状态胶囊（"已连接"/"离线"）、`#wallpaper-refresh`、`#theme-toggle`、`#clock` |
| 桌面图标 `.desktop-icons` | 6 个内置应用 + 远端桌面条目（可拖拽、吸附网格、右键菜单） |
| 窗口层 `#window-layer` | 8 个固定窗口 + 每个 Screen 一个窗口 |
| 开始菜单 `#start-menu` | 3 列应用网格 + `#menu-session` + 「重启服务器」+「断开」(`#menu-power`) |
| 程序坞 `.dock` | `#dock-launcher`、6 个应用项、新建 Screen 项、各 Screen 徽标项 |
| 右键菜单 `#context-menu` | 动态 items，支持 separator / danger / disabled |
| 上传输入 `#file-upload-input` | `<input type="file" multiple>`，类 `hidden` |
| 指纹模态 `#modal-backdrop` | `#modal-title`（确认主机指纹）、`#modal-message`、`#modal-code`、`#modal-cancel`、`#modal-confirm` |
| 通用对话框 `#file-dialog-backdrop` | `#file-dialog`，4 种 type（见 6.5） |
| 进度对话框 `#progress-dialog-backdrop` | `#progress-title`、`#progress-detail`、`#progress-fill`、`#progress-percent`、`#progress-bytes`、`#progress-error`、`#progress-close` |
| Toast `#toast-region` | 3.4 s 自动消失；类 toast + success/error |

内置桌面应用（`desktopApps`，顺序即网格顺序）：

| app | label | icon | title |
| --- | --- | --- | --- |
| `connect` | 新建连接 | `#i-plus` | 新建 SSH 连接 |
| `terminal` | 终端 | `#i-terminal` | 打开终端 |
| `files` | 文件管理 | `#i-folder` | 打开文件管理 |
| `monitor` | 资源监控 | `#i-monitor` | 打开系统监控 |
| `history` | 会话记录 | `#i-history` | 打开操作历史 |
| `settings` | 设置 | `#i-settings` | 打开设置 |

### 6.3 窗口系统（windows 状态 + 默认几何）

| key | 标题 | `--x` | `--y` | `--w` | `--h` | 初始 visible |
| --- | --- | --- | --- | --- | --- | --- |
| `welcome` | 欢迎使用 WebSSH | `calc(50% - 270px)` | `calc(50% - 210px)` | 540px | 420px | = settings.showWelcome |
| `connect` | 新建 SSH 连接 | `calc(50% - 390px)` | `10%` | 780px | 650px | false |
| `terminal` | 终端 | `8%` | `9%` | 900px | 620px | false |
| `files` | 文件管理 | `14%` | `12%` | 850px | 570px | false |
| `editor` | 文本编辑器 | `12%` | `8%` | 920px | 650px | false |
| `monitor` | 资源监控 | `18%` | `10%` | 820px | 590px | false |
| `history` | 会话记录 | `20%` | `12%` | 780px | 540px | false |
| `settings` | 工作台设置 | `calc(50% - 320px)` | `14%` | 640px | 520px | false |
| `screenWindows[name]` | label + `screen · name` | 槽位 `24 + slot*24` | 同左 | 900px | 620px | false |

- 窗口状态：`{visible, z, x, y, maximized}`；Screen 窗口额外带 `{session, terminal, fit, socket, connected}`。
- `appZ` 从 21 递增；welcome 初始 z=21，其余 z=20。
- 三键：最小化（minimizeWindow）、最大化（maximizeWindow，仅切 maximized 布尔，样式改为铺满）、关闭（closeApp）。
- 终端窗口关闭 = 断开终端 WS；监控窗口关闭/最小化 = 停止轮询；编辑器关闭前若脏需确认；关闭 welcome 且无连接时自动打开 connect 窗口。
- openApp 副作用：files → loadFiles()；monitor → startMetrics()；terminal → 未连接则 connectTerminal()，否则 ensureTerminal() + sendResize()；editor → ensureEditor() 后 resize()+focus()；connect → 重置表单。
- 拖拽：pointerdown 于 .window-bar（点击的是 button、视口 ≤767px、已最大化时不启动）→ 全局 pointermove → pointerup 结束；坐标钳制在 #window-layer 内，底部预留 66px。
- 动画：窗口打开 480 ms、关闭 300 ms、最小化入坞 430 ms、模态关闭 240 ms、菜单 150–190 ms；prefers-reduced-motion: reduce 全部跳过。

### 6.4 各窗口字段与交互

#### 欢迎窗口（welcome）
- 文案：`安全远程工作台` / `服务器，就在你的桌面。` / "在浏览器里连接 Linux 主机，处理终端、文件和系统指标。敏感凭据只保留在当前页面内存中。" / 凭据存储说明。
- 按钮：`data-open="connect"`「新建 SSH 连接」、`data-open="settings"`「工作台设置」。

#### 新建连接窗口（connect）
- 左栏 .connect-aside（≤900px 隐藏）：标题"新建会话 / 连接远程 Linux 主机 / 使用密码或 PEM/OpenSSH 私钥认证。首次连接前请核对主机指纹。"；连接列表 #saved-connections-list；协议标签 SSH-2.0、SFTP、WebSocket 流。
- 连接条目：主标题 `item.name || "<username>@<host>"`；副标题 `<username>@<host>:<port>`；右侧 × 删除（@click.stop）。空态"暂无保存的连接"。
- 表单 #connection-form（novalidate，@submit.prevent=connect(false)）：

| 字段 | name | 控件 | 备注 |
| --- | --- | --- | --- |
| 主机地址 * | `host` | text（v-model.trim） | placeholder `192.168.1.10、2001:db8::1 或 server.example.com` |
| 端口 * | `port` | number min1 max65535（v-model.number） | 默认 22 |
| 用户名 * | `username` | text | placeholder `root`，autocomplete=username |
| 连接名称 | `name` | text | placeholder `例如：生产环境 A` |
| 认证方式 | `authMethod` | radio | password→"密码"，key→"私钥" |
| 密码 * | `password` | password | #password-fields（v-show），placeholder `保存配置后会记住密码` |
| 私钥 * | `privateKey` | textarea rows=5 spellcheck=false | #key-fields，placeholder `-----BEGIN OPENSSH PRIVATE KEY-----` |
| 私钥口令 | `passphrase` | password | 可选，placeholder `可选` |

- 按钮：#save-connection「保存配置」、#test-connection「测试连接」、#connect-submit「建立连接」（type=submit）。
- 文案随状态切换：connecting && testing → "测试中..."；connecting && !testing → "连接中..."；两者都 disabled=connecting。
- 错误行 #form-error（role=alert，内容 formError）。
- 底部提示："密码和私钥会保存在浏览器本地"。
- 移动端：.connect-aside 隐藏，表单顶部出现 .mobile-saved-connections（同一份数据的第二份渲染）。

#### 终端窗口（terminal）
- 标题栏：`终端` + 副标题 #terminal-host = connectionLabel（`<username>@<host>`，IPv6 自动加方括号）。
- 工具按钮：#terminal-clear「清屏」、#terminal-copy（复制选中）、#font-down「小」、#font-up「大」、#terminal-reconnect（重连）。
- 内容：#terminal-surface（role=log）内 #terminal-output（display:none）、#terminal-input（hidden textarea）、#terminal-overlay（未连接时显示，含"新建连接"按钮）。
- 状态栏：#terminal-state（i 元素 + " 已连接"/" 未连接"）、#terminal-size（`"{cols} x {rows}"`）、固定 `UTF-8`。
- 字号：11..22，changeFont(±1) 后立即 fit() + sendResize() 并 persist()。

#### Screen 窗口（每个会话一个）
- 标题：session.label，副标题 `screen · <name>`；右侧状态胶囊 `已连接` / `后台运行`。
- 三键：最小化到后台、最大化、关闭窗口并后台运行（关闭与最小化行为相同，都不杀远端）。
- 状态栏：状态点 + 状态文本，第二段 `session.path || '独立 Screen 终端'`，第三段 UTF-8。
- Dock 项：徽标 = screenBadge(label) = label 首字符大写（空则 S）；右键菜单：`打开窗口`/`打开 / 恢复`、`最小化到后台`（未显示时禁用）、`新建 Screen`、分隔线、`退出会话`（danger）。

#### 文件管理窗口（files）
- 工具栏：#file-up（上级）、#file-path 输入（Enter 生效）、#file-go、#file-refresh、`+ 目录`（data-file-action="mkdir"）、`+ 文件`（data-file-action="create"）。
- 表格列：file-select-cell 复选框、名称、权限、所有者、大小、修改时间、操作。
- 行内操作按钮：编辑（仅 file）、下载（仅 file）、重命名、删除。
- 名称单元格 .file-name：双击 openFileEntry（目录→进入；.sh→screen 运行；其他→打开编辑器）；hover 时动态设 title（"打开目录"/"使用 screen 运行"/"打开编辑"）。
- 表头全选 #file-select-all，支持 indeterminate（someFilesSelected）。
- 空态 #file-state：加载中... / 目录为空 / 错误消息 / 尚未连接（未连接时附带"连接主机后浏览远程文件系统"）。
- 底部 #file-count：`"<n> 个项目"` 或 `"<n> 个项目，已选择 <m> 个"`；右侧固定 `SFTP 安全通道`。

#### 编辑器窗口（editor）
- 标题栏：`文本编辑器` + #editor-file-name（editorName = 路径最后一段，无则"未打开文件"）；按钮 #editor-reload「重新加载」（disabled=!editorPath）、#editor-save「保存」（disabled=!editorDirty）。
- 内容：#text-editor（Ace 容器，v-pre）。
- 状态栏：#editor-path（editorPath || '未打开文件'）、#editor-state。

#### 资源监控窗口（monitor）
- 标题副标 #metrics-time；#metrics-refresh 手动刷新。
- 卡片（metricCards）：处理器（逻辑核心 `<n> 核`、型号）、内存（已用/可用/总计）、交换分区（已用/总计）、根目录磁盘（已用/可用/总计）；百分比 = `value.toFixed(1) + " %"`，进度条宽度 value%。
- 趋势图 #trend-chart（viewBox 0 0 700 220，preserveAspectRatio=none）：#cpu-line、#memory-line；网格线 M0 20H700 … M0 220H700；标题"资源趋势"、副标"最近 20 次采样"；图例 CPU / Memory。
- #system-facts：主机名、系统、系统负载、运行时间、进程数、累计接收、累计发送。

#### 会话记录窗口（history）
- 工具栏：#history-filter（placeholder `筛选命令、文件或任务...`）、#history-copy「复制」、#history-export「导出 CSV」、#history-clear「清空」（danger）。
- 列表 #history-list：每行 time + 类型中文 + `<code>{{ item.value }}</code>`；空态"暂无匹配的操作记录"。

#### 设置窗口（settings）
- 段落：APPEARANCE & SESSION / 工作台偏好；底部警告"密码和私钥会写入浏览器 localStorage；可在上方开关控制。"。
- 控件：

| 控件 id | 字段 | 类型 | 标签 / 说明 |
| --- | --- | --- | --- |
| `#setting-theme` | settings.theme | select：dark 深色 / light 浅色 / system 跟随系统 | 界面主题 / 切换浅色或深色显示 |
| `#setting-font` | font | range 11..22 step1 | 终端字号 / 基础终端显示字号；输出 #font-output = `"<n>px"` |
| `#setting-show-welcome` | settings.showWelcome | checkbox.switch | 启动时显示欢迎页 |
| `#setting-auto-terminal` | settings.autoOpenTerminal | checkbox.switch | 连接后自动打开终端 |
| `#setting-reconnect` | settings.reconnect | checkbox.switch | 自动重连 / 终端意外断开后尝试恢复 |
| `#setting-screen-auto-exit` | settings.screenAutoExit | checkbox.switch | 程序结束自动退出 Screen（关闭后程序结束会保留 Screen 并进入 shell） |
| `#setting-confirm` | settings.confirm | checkbox.switch | 危险操作确认 / 删除、移动和断开前再次确认 |
| `#setting-save` | settings.save | checkbox.switch | 保存连接密码 / 密码和私钥以明文保存在浏览器 localStorage 中 |

- 事件：settingsChanged（theme/showWelcome/autoOpenTerminal/reconnect/screenAutoExit/confirm）→ applyTheme() + persist()；saveSettingChanged、fontChanged 仅 persist()。
- 重要副作用：settings.save 变为 false 时，立即清空内存中所有已保存连接的 password/privateKey/passphrase 并 persist（webssh.js:81）。

### 6.5 对话框（openDialog / dialog 状态）

字段：`{visible, type, title, kicker, description, value, format, formats, submitLabel, cancelLabel, icon, danger, error, resolve}`。

- kicker 自动判定：confirm → 操作确认；permissions → 权限管理；archive → 压缩设置；其他 → 文件操作。
- 默认值：submitLabel='确定'、cancelLabel='取消'、icon=#i-file、type='input'。
- 提交校验（submitDialog）：
  - confirm → 直接 resolve true；
  - 值 trim 后为空 → dialog.error = '请输入有效内容'；
  - permissions 且不匹配 `^[0-7]{3,4}$` → '请输入 3 或 4 位八进制权限，例如 644 或 0755'；
  - 非 permissions 且值含 `/` 或值为 . 或 .. → '名称不能包含 /，也不能是 . 或 ..'；
  - archive 返回 {name, format}，其他返回字符串。
- 关闭：取消按钮、右上 ×、点击背板、Escape → resolve(null)。
- 权限编辑器（type=permissions）：3 行（所有者/用户组/其他用户）× 3 列（读取/写入/执行），每格 data-permission 八进制位（400 200 100 / 40 20 10 / 4 2 1）；勾选变化 → syncPermissionMode() 重算 dialog.value（toString(8).padStart(3,'0')）；文本变化 → syncPermissionChecks() 反填勾选。文本框 #permission-mode（maxlength=4，pattern="[0-7]{3,4}"）。
- 压缩对话框（type=archive）：名称标签改为"基础名称"；格式按钮组 .archive-format-option（aria-pressed），字段 {value,label,description}。
- confirmDialog(title, description, submitLabel='继续', danger=false, cancelLabel='取消')：icon 在 danger 时为 #i-trash，否则 #i-settings。

### 6.6 右键菜单项（entryMenu）

真实顺序：

1. primary：目录 → 「打开」；可执行文件（单选）→ 「使用 screen 运行」「编辑」；其他 → 「编辑」（多选文案 `编辑（仅 <name>）`），单选时再追加「使用 screen 运行」。
2. 「上传文件」（单选且目标为目录）/「上传到所在文件夹」。
3. 「下载」/「下载 N 个项目」。
4. 「压缩归档」/「压缩 N 个项目」。
5. 「解压到文件夹」（仅单选、非目录、名字匹配 `/\.(zip|tar\.gz|tgz|gz)$/i`）。
6. 分隔线。
7. 「复制」/「复制 N 个项目」、「剪切」/「剪切 N 个项目」、「重命名」（多选禁用）。
8. 分隔线。
9. 背景项（backgroundMenu(目标目录, desktop, false)）：粘贴（不可用禁用）、刷新、（桌面）自动排列、分隔线、新建文件、新建文件夹。
10. 分隔线。
11. 「权限管理」/「权限管理（N 项）」。
12. 「发送到桌面」/「发送 N 项到桌面」（仅文件管理器，桌面自身不显示）。
13. 分隔线。
14. 「删除」/「删除 N 个项目」（danger）。

空白处菜单（backgroundMenu）：「上传文件」（withUpload）、「粘贴」、「刷新」、（桌面）「自动排列」、分隔线、「新建文件」、「新建文件夹」。
定位：x = clamp(8, clientX, innerWidth-228)，y = clamp(8, clientY, innerHeight - max(80, items*36) - 8)。

### 6.7 键盘与指针

| 触发 | 行为 |
| --- | --- |
| Escape（window） | 依次：关浮动菜单 → 关对话框(resolve null) → 关指纹确认(false) → 进度框 done 时关闭 |
| 终端内 Ctrl/Cmd+C | 有选中 → 复制并清选区（不发送 ^C）；无选中 → 发送 U+0003 |
| 终端内 Ctrl/Cmd+V | 发送 U+0016，阻止浏览器默认粘贴 |
| 编辑器 Ctrl-S / Cmd-S | 保存（saveRemoteFile 命令） |
| 路径输入 Enter | loadFiles(pathInput) |
| 图标 pointerdown → 移动 ≥6px | 进入拖拽；松开吸附网格，并抑制 250 ms 内 click |
| 窗口 pointerdown | 置顶（appZ++ 赋给该窗口） |
| beforeunload | 编辑器脏时 preventDefault() + returnValue='' |

- attachCustomKeyEventHandler：非 keydown、或既无 Ctrl 也无 Meta、或带 Alt → 返回 true（走默认），只有上述两键被拦截。

### 6.8 存储键与 JSON 形状

| 键 | 存储位置 | 形状 |
| --- | --- | --- |
| `webssh.settings` | localStorage | `{"theme":"system","reconnect":true,"confirm":true,"save":true,"screenAutoExit":true,"autoOpenTerminal":true,"showWelcome":true,"font":14}` |
| `webssh.connections` | localStorage | `[{"id":"<uuid>","name":"","host":"","port":22,"username":"","authMethod":"password","password":"","privateKey":"","passphrase":""}]` |
| `webssh.history` | localStorage | `[{"time":"2026-10-20T07:28:38.000Z","type":"CONNECT","value":"root@host:22"}]`，仅保留最近 150 条 |
| `webssh.desktop-icons` | localStorage | `{"connect":{"x":24,"y":78},"terminal":{"x":24,"y":188},"/root/.webssh/desktop/a.txt":{"x":128,"y":78}}` |
| `webssh.activeConnection` | sessionStorage | `{"id":"...","host":"...","port":22,"username":"...","name":"..."}` |

- 所有读取都 try/catch 静默降级。
- persist() 一次写 settings + connections + history。
- 旧版兼容：webssh.connections 为空时，若 webssh.settings.profile 是合法连接对象，则迁移成单元素数组。

### 6.9 桌面图标布局算法

- 网格（desktopGrid）：移动端（≤767px）startX=10, startY=66, stepX=70, stepY=90；桌面端 24, 78, 104, 110；rows = max(1, floor((innerHeight - startY - 72) / stepY))。
- 默认位置：column = floor(index/rows)，row = index % rows → x = startX + column*stepX，y = startY + row*stepY。
- 钳制：x ∈ [8, innerWidth-width-8]，y ∈ [58, innerHeight-height-74]；尺寸移动端 66×82、桌面端 92×96。
- normalizeDesktopIcons：遍历 [内置应用..., 远端条目...]，用 `"col:row"` 去重占用，冲突时从 0 号槽往后找第一个空位（最多 500 次）。
- placeNewDesktopIcons：新出现的远端条目从当前占用最大索引 +1 起找空位。
- snapIconToGrid：移动端 {x:70,y:90,startX:10,startY:66,cols:3}；桌面端 {x:104,y:110,startX:24,startY:78,cols:max(1,floor((innerWidth-36)/104))}，在 20 行 × cols 内找最近空位。
- 「自动排列」：按 [内置应用..., 远端条目...] 顺序重写全部坐标。

### 6.10 主题

- 三态 system/light/dark，默认 system；resolvedTheme 在 system 时取 prefers-color-scheme。
- applyTheme() 步骤：
  1. 非法值回退 system；
  2. document.documentElement.dataset.theme = resolved；
  3. document.documentElement.style.colorScheme = resolved；
  4. 主终端 options.theme = terminalThemes[resolved]、options.fontSize = font；
  5. 所有 Screen 终端 options.theme 同步；
  6. Ace：dark → ace/theme/tomorrow_night_blue，light → ace/theme/chrome；
  7. #theme-toggle 设 aria-pressed = (resolved === 'dark')。
- 顶栏按钮：图标 system→#i-theme-auto、light→#i-sun、dark→#i-moon；title/aria-label = `界面主题：自动|浅色|暗色（点击切换）`；点击循环 system → light → dark → system。
- 首屏防闪：index.html 内联脚本先读 webssh.settings.theme 并立即设置 data-theme。
- 系统主题变化监听：systemTheme.addEventListener('change')，仅在 theme==='system' 时重应用。
- 终端主题常量（逐字）：
  - `light: { background: '#f5faff', foreground: '#10233e', cursor: '#1379ea', selectionBackground: '#1379ea40' }`
  - `dark:  { background: '#071523', foreground: '#edf6ff', cursor: '#65b5ff', selectionBackground: '#65b5ff52' }`
- CSS 变量（theme.css）：html[data-theme="light"] 与 html[data-theme="dark"] 各一套：--theme-bg、--theme-surface、--theme-surface-soft、--theme-surface-hover、--theme-border、--theme-border-soft、--theme-text、--theme-muted、--theme-accent、--theme-accent-hover、--theme-accent-text、--theme-topbar、--theme-glass、--theme-shadow、--theme-danger、--theme-danger-soft、--theme-success、--theme-terminal-bg、--theme-terminal-text、--theme-terminal-cursor、--theme-terminal-selection、--theme-mask。

### 6.11 移动端适配

媒体查询：`@media (max-width: 767px), (hover: none) and (pointer: coarse) and (max-width: 1024px)`（mobile.css）；另有 max-width:374px 与 webssh.css 内 900px/767px/380px 断点。

- 变量：--mobile-top = calc(52px + safe-area-inset-top)；--mobile-dock = calc(76px + safe-area-inset-bottom)。
- 顶栏变状态栏：固定、圆角 20px、玻璃模糊；隐藏 .edition、.top-context、.network-button；#clock 显示。
- 桌面图标改为 4 列网格（≤374px → 3 列），position: relative !important，可纵向滚动；图标块 52px，标签 10px。
- 应用窗口全屏化：inset: var(--mobile-top) 0 var(--mobile-dock) !important，圆角 22px，.window-bar 固定 48px；隐藏最大化按钮（[data-window-action="max"] 与 Screen 窗口第 2 个按钮）。
- 文件表格只留复选框 + 名称两列；工具栏换行；路径输入独占一行。
- 监控：卡片 2 列；.monitor-lower 单列堆叠（图表/系统状态最小高 260px）。
- 历史：工具栏 3 列网格，搜索框跨整行，行布局 68px 48px 1fr，code 允许换行。
- Dock：固定底部、横向滚动、隐藏内置应用项与分隔线；仅保留启动器、新建 Screen、各 Screen。
- 开始菜单 → 底部抽屉（::before 拖拽把手，圆角 24px，3 列网格）；右键菜单 → 底部抽屉（max-height: min(70dvh, 560px)）；模态/对话框 → 底部对齐 + 把手。
- Toast：顶部通栏（top = mobile-top + 8px，宽度 100vw - 20px）。
- 拖拽在 ≤767px 被禁用（startWindowDrag / startScreenWindowDrag 直接 return）。
- 触摸打开桌面条目：仅在 matchMedia('(hover: none), (pointer: coarse)') 为真时单击生效。

---

## 7. 指纹确认、连接测试、认证模式

### 7.1 认证模式

`authMethod` 只有两个取值：

**`password`**
- JSch 配置：`session.setConfig("PreferredAuthentications", "password,keyboard-interactive")`、`session.setPassword(profile.password)`。
- 未设置私钥。
- 密码为空/空白 → `400 VALIDATION_ERROR / "password is required"`。

**`key`**
- `jsch.addIdentity("webssh-memory-key", privateKey.getBytes(UTF_8), null, passphraseBytes)`（`passphrase` 空白则传 `null`）；私钥**只在内存**，不落盘。
- `PreferredAuthentications = "publickey"`，`session.setPassword(null)`。
- 私钥文本为空 → `400 VALIDATION_ERROR / "privateKey is required"`。
- 支持 OpenSSH/PEM 文本；口令可空。

**公共设置**
- `StrictHostKeyChecking = "yes"`（真正的校验被替换成"全部接受"的 HostKeyRepository，见 7.2）。
- `setServerAliveInterval(15000)`、`setServerAliveCountMax(3)`。
- 主机名若以 `[` 开头且以 `]` 结尾，剥掉方括号（IPv6 字面量）。
- 超时：`session.connect(connectTimeoutMs)`。

### 7.2 主机指纹流程

后端**不做** known_hosts 持久化，也不真的拒绝未知主机：

- `ConnectionManager.createSession(profile, acceptHostKey=true)` 时装配 `AcceptingHostKeyRepository`：
  - `check(host, key)` 恒返回 `HostKeyRepository.OK`；
  - `add/remove` 空实现；
  - `getKnownHostsRepositoryID()` 返回 `"webssh-ephemeral-trust"`；
  - `getHostKey(...)` 返回空数组。
- 所以 `StrictHostKeyChecking=yes` 只是形式，任何主机密钥都被接受；**安全边界完全依赖前端的一次性人工确认**。

指纹计算（`ConnectionManager.fingerprint`）：

```java
HostKey key = session.getHostKey();
String value = "SHA256:" + Base64.getEncoder().withoutPadding()
    .encodeToString(MessageDigest.getInstance("SHA-256")
    .digest(Base64.getDecoder().decode(key.getKey())));
return Map.of("host", session.getHost(), "port", session.getPort(),
              "algorithm", key.getType(), "value", value, "changed", false);
```

- 若 `Base64.getDecoder().decode()` 失败 → `IllegalStateException("无法计算主机指纹")`。
- `changed` 恒 `false`（没有历史比对）。

### 7.3 前端两步式连接流程（必须逐步复刻）

`connect(isTest)`：

1. 前置校验：`!form.host || !form.username || !form.port` → `formError = '请完整填写连接信息'`，**不发请求**。
2. 组装 `profile()`：`{...form, port: Number(form.port), trustFingerprint: false}`。
3. `connecting = true; testing = isTest`。
4. `POST /api/v1/connections/test` → `tested`。
   - 若 `isTest`（"测试连接"按钮）：toast `认证成功，指纹为 <fingerprint.value | '已验证'>`（success），结束。
5. 弹指纹确认框：`fingerprintConfirm({...data, ...tested.fingerprint})`
   - 文案：`服务器返回了一个新的主机身份。请确认它与可信来源一致后继续连接 <host>:<port>。`
   - 指纹行：`"<algorithm || 'ssh'>  <value || 'fingerprint unavailable'>"`（两个空格分隔）。
   - 按钮；`取消` → resolve false；`确认并继续` → resolve true。
   - 用户取消 → 直接 return（不建连，不报错）。
6. `data.trustFingerprint = true` → `POST /api/v1/connections`。
7. 成功：
   - `connection = {...data, id: result.id}`（**注意：此时 connection 里含明文 password/privateKey/passphrase**，且已叠加测试阶段返回的 fingerprint 字段）；
   - `persistActive()`（写 sessionStorage）；
   - `suppressClose = false`；
   - `windows.welcome.visible = false`；
   - 若 `settings.autoOpenTerminal` → `openApp('terminal')`；
   - 记录历史 `CONNECT` / `"<username>@<host>:<port>"`；
   - toast `SSH 连接已建立`；
   - `syncServerTime()`。
8. 失败：`formError = error.message` + toast。
9. finally：`connecting = false; testing = false`。

### 7.4 页面刷新后的会话恢复

- `restoreConnection()`：读 sessionStorage `webssh.activeConnection`；校验 `id/host/username` 都存在。
- `GET /api/v1/connections/<id>/status` 成功 → 恢复 `connection`（**不重建 SSH 会话，也不重连终端**，因为服务端内存里会话还在）；`suppressClose=false`、隐藏 welcome、toast `已恢复 SSH 连接`、`syncServerTime()`。
- 失败 → `sessionStorage.removeItem(activeConnectionKey)`。
- 随后无论成功与否都会 `loadScreenSessions()`。

### 7.5 断连与重启时的清理

`disconnect()`：若 `settings.confirm` 先确认 → `DELETE /api/v1/connections/<id>`（失败忽略）→ `disconnectTerminal()` → 关闭并 dispose 所有 Screen 窗口 → `stopMetrics()` → 记历史 `DISCONNECT` → `connection=null`、清空 `screenSessions`、`serverTimeOffset=0`、`persistActive()`、清空 `desktopEntries`/`fileEntries` → toast `连接已断开`。

`handleConnectionLost()`：由 410/CONNECTION_CLOSED 触发；不做 DELETE 请求，其余清理相同，toast `SSH 连接已断开，请重新连接`（error）。

`rebootServer()`：危险确认 → `POST /power {action:'reboot'}` → 记历史 `REBOOT` → 与 handleConnectionLost 相同的本地清理（但**不删服务端连接**）→ toast `服务器重启命令已发送`。

---

## 8. SSH / SFTP 行为细节

### 8.1 连接与通道管理（`ConnectionManager` / `SshConnection`）

- 连接表：`ConcurrentHashMap<String, SshConnection>`，key 为随机 UUID；进程退出即全部丢失（无持久化、无上限、无空闲回收）。
- `require(id)`：不存在 → `404 CONNECTION_NOT_FOUND`；存在但 `!session.isConnected()` → 先 `connections.remove(id)` 再 `410 CONNECTION_CLOSED`。
- `openSftp()`：每次调用**新建** `ChannelSftp` 并 `connect(connectTimeoutMs)`；所有 SFTP 调用点都在 try/finally 里 `disconnect()`（即"一次操作一个通道"）。
- `connectChannel()`：若 `connect()` 抛 `JSchException` 且耗时 ≥ `connectTimeoutMs * 0.8`，判定为网络级故障并 `session.disconnect()`（惰性失效）。
- `exec(command)`：默认超时 `commandTimeoutMs`。
  - `ChannelExec`，`setInputStream(null)`，stderr 收进 `ByteArrayOutputStream`；
  - 轮询循环：`while (!channel.isClosed())` → 抽干 `stdout.available()` → 检查 deadline → `Thread.sleep(20)`；
  - 退出码 ≠ 0 → 抛 `IllegalStateException(stderr.trim() 非空 ? stderr : "远程命令执行失败，退出码：<code>")`；
  - 超时 → `IllegalStateException("远程命令执行超时")`。
- `streamExec(command, dest, timeoutMs)`：同样轮询，但把 stdout 以 **64 KiB** 缓冲直接写入 `dest`，结束时 `flush()`；退出码 ≠ 0 抛 `IllegalStateException`。
- 注意：`exec` 在超时后**不会** kill 远端命令，只是断开通道。

### 8.2 分片上传协议（完整状态机）

**常量**：`chunkSize = ssh.uploadChunkBytes`（默认 8 MiB）、`retries = ssh.uploadChunkRetries`（默认 3）、`maxUploadBytes`（默认 1 000 000 000 B ≈ 0.93 GiB）。

**服务端状态**（`UploadTask`）：`{id, connectionId, path, temporary, size, overwrite, offset, updatedAt, completed}`。
- `temporary = path + ".webssh-upload-" + id + ".part"`（创建时立即用空流 `put` 建一个 0 字节文件）。
- 惰性清理：任何 create/status 调用都会先 `cleanupExpired()`，把 `updatedAt < now - uploadIdleTimeoutMs` 的任务移除并异步删除远端临时文件。

**前端流程**（`uploadFiles`）：

```
for each file:
  POST   /files/uploads                      {path, size}          → {uploadId, status, path, size, offset, chunkSize, chunkRetries}
  offset = task.offset (默认 0)
  while offset < file.size:
    end = min(file.size, offset + chunkSize)
    attempt = 0
    while attempt < retries && !sent:
      try:
        PUT /files/uploads/{uploadId}/chunks?offset=<offset>
            Content-Type: application/octet-stream
            body = file.slice(offset, end)
        → {offset: <newOffset>, ...} ; offset = newOffset ; sent = true
      catch e:
        # 先向服务端核对真实偏移，能对齐就直接认为这一片已成功
        GET /files/uploads/{uploadId} → offset = state.offset
        if offset >= end: sent = true
        if !sent: sleep 500 * (attempt + 1) ms
      attempt++
    if !sent: throw lastError
    showProgress('正在上传', file.name, (loaded + offset) * 100 / total, loaded + offset, total)
  POST   /files/uploads/{uploadId}/complete   (无 body)             → {uploadId, status:'completed', path, size}
  loaded += file.size ; completed++
  addHistory('UPLOAD', data.path)
catch:
  if base && task.uploadId: DELETE /files/uploads/{uploadId}   (失败忽略)
  toast('<file.name>：<error.message>', 'error')
```

**同名冲突**（`api()` 拦截器，仅针对 `POST` 且 URL 以 `/files/uploads` 结尾）：
- 若响应 `status === 'conflict' && code === 'FILE_EXISTS'`：
  1. `progress.visible = false`；
  2. 弹确认框：标题 `覆盖“<文件名>”？`，描述 `目标位置 <path> 已存在同名文件，请选择处理方式。`，确认按钮 `覆盖`（danger），取消按钮 `跳过`；
  3. 确认 → 以 `overwrite: true` **递归重发同一请求**；
  4. 跳过 → `uploadSkipped++`，抛出带 `code='UPLOAD_SKIPPED'` 的 Error（toast 层遇到以 `：已跳过` 结尾的 error 会被吞掉）。
- 若 `POST /files/uploads` 成功但响应没有 `uploadId` → 抛 `code='INVALID_UPLOAD_TASK'`，消息 `服务器未返回有效的上传任务，请重启服务后重试`。

**完成阶段的原子性**：
1. 校验远端临时文件大小 == 声明 `size`；
2. 目标存在且非目录：先 `rename(path, path + ".webssh-backup-" + uploadId)`；
3. `rename(temporary, path)`；若失败且做过备份则 `rename(backup, path)` 回滚，再抛出；
4. 成功后 `rm(backup)`（失败仅记日志 `"无法删除上传备份文件 {}"`）。

**断点续传**：服务端不保存 `offset` 到磁盘，而是每次以远端临时文件实际大小为准（`sftp.stat(temporary).getSize()`）；因此**只要临时文件还在且未被清理，重开页面也能续传**（但前端只会在同一次 `uploadFiles` 调用内复用，刷新后需要重新 POST 创建，因 `(connectionId, path, size, overwrite)` 命中会返回同一任务）。

### 8.3 下载流式行为

- 普通文件：`sftp.get(path)` 的 `InputStream` → `res.raw().getOutputStream()`，`transferTo`（Java 9+ 默认 8 KiB 缓冲）。
- 目录：先 `sftp.disconnect()`（避免与 exec 通道争用），再 `streamExec(tar -czf - ...)` 写响应（64 KiB 缓冲）。
- 客户端取消：捕获 `IOException` 仅 `logger.warn("Download cancelled by client: {}", path)`。
- 文件名编码：`URLEncoder.encode(name, UTF_8).replace("+", "%20")`，放在 `filename*=UTF-8''` 之后（RFC 5987）。

### 8.4 文本编辑大小限制与编码

| 限制 | 值 | 位置 |
| --- | --- | --- |
| 最大可编辑字节数 | `2 * 1024 * 1024`（2 MiB） | `MAX_EDITABLE_FILE_BYTES` |
| 读取保护 | `readNBytes(MAX+1)`，超长即拒 | 读文件 |
| 写保护 | `content.getBytes(UTF_8).length > MAX` 即拒 | `action=write/create` |
| 二进制判定 | 任一字节为 `0x00` → `415 BINARY_FILE` | 读文件 |
| 编码判定 | `UTF-8` decoder，`onMalformedInput(REPORT)` + `onUnmappableCharacter(REPORT)`，失败 → `415 UNSUPPORTED_ENCODING` | 读文件 |
| 目录 | `400 NOT_A_FILE` | 读文件 |

- 写入不做编码检测（前端 Ace 内容按 UTF-8 上传）。
- 保存前后端不校验 `modifiedAt`/ETag（**无冲突检测**，后写覆盖）。

### 8.5 权限与所有者

- 读取：`permissions`（如 `-rw-r--r--`）、`mode`（4 位八进制字符串，如 `0644`）、`owner`（**数字 uid 字符串**，如 `"0"`）。
- 修改：`POST /files/operation {action:'chmod', path, mode}`，`mode` 正则 `[0-7]{3,4}` → `Integer.parseInt(mode, 8)` → `sftp.chmod()`。
- 前端默认值：目录 `0755`、文件 `0644`（`changePermissions` 初始化 `value: entries[0].mode || (type==='directory' ? '0755' : '0644')`）。
- 批量设置时串行逐条提交，失败逐条 toast。
- 复制/重命名**不**保留权限与时间戳（`copy` 用 `put` 新建文件；`rename` 由 SFTP 服务端决定）。

### 8.6 可执行判定（前端 `isExecutableEntry`）

```js
type === 'file' && (
  entry.path?.toLowerCase().endsWith('.sh') ||
  /x/.test(entry.permissions || '') ||
  (parseInt(entry.mode || '0', 8) & 0o111) !== 0
)
```

即：扩展名 `.sh`、或权限串含 `x`、或 mode 任一执行位。命中时文件双击/右键首选动作是"使用 screen 运行"。

后端执行前的二次校验（`POST /screen-sessions` 带 `path`）：`(attrs.getPermissions() & 0111) == 0` → `400 NOT_EXECUTABLE / "文件没有执行权限"`；目录 → `400 NOT_EXECUTABLE / "目录不能直接运行"`。

---

## 9. 移植检查清单（验收要点）

1. **API 形状逐字一致**：字段名、错误 `{error:{status,code,message}}` 结构、状态码（注意 §3.2 中 power 的 200/202 差异、uploads 的 201）。
2. **WS 帧逐字一致**：`{"type":"status","message":"connected"}`、`{"type":"output","data":...}`、`{"type":"error",...}`；任务帧必须带 `taskId`。
3. **shell 命令逐字一致**：特别是 `screen -DmS ... sh -lc '<script>' </dev/null >/dev/null 2>&1`、`tar -czf - -C ...`、`du -sk` / `head -c` 的限额检查。
4. **所有远端写入路径的引号处理**：必须使用与 `<Q()>` 等价的 POSIX 单引号转义。
5. **配额常量**：2 MiB 编辑上限、10 000 归档条目、2 GiB 解压上限、200 条 paths 上限、16 KiB 快捷方式文件上限、200 条本地快捷方式上限、150 条历史、20 个监控采样点。
6. **超时**：`connectTimeoutMs=15000`、`commandTimeoutMs=30000`、screen 创建 1500 ms、`fileJobTimeoutMs=1800000`、`uploadIdleTimeoutMs=1800000`。
7. **前端轮询节奏**：Screen 列表 4000 ms、监控 1000 ms、文件任务 400 ms、重连 1800 ms、多文件下载间隔 350 ms。
8. **localStorage 键名与结构**（§6.8）不可改名，以便与旧版共存/迁移。
9. **指纹流程**必须保留"先 test 拿指纹 → 人工确认 → 带 trustFingerprint=true 再 connect"的两步语义，以及后端 `409 FINGERPRINT_REQUIRED` 的兜底。
10. **中文文案**保持原文（错误 message、确认框、toast、按钮），便于对照回归。
