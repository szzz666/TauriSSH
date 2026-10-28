use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::model::*;
use crate::remote::{self, ToolStatus};
use crate::sftp;
use crate::ssh::{self, Session, TerminalCommand};
use crate::AppState;

fn to_value<T: Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|e| AppError::internal(e.to_string()))
}

#[tauri::command]
pub async fn ssh_test(state: State<'_, AppState>, profile: ConnectionProfile) -> AppResult<Value> {
    profile.validate()?;
    let (handle, fingerprint) = ssh::connect_and_authenticate(&profile).await?;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "test complete", "en")
        .await;
    let _ = state;
    Ok(json!({
        "ok": true,
        "message": "SSH 身份验证成功",
        "fingerprint": fingerprint,
    }))
}

#[tauri::command]
pub async fn ssh_connect(state: State<'_, AppState>, profile: ConnectionProfile) -> AppResult<Value> {
    profile.validate()?;
    let (handle, fingerprint) = ssh::connect_and_authenticate(&profile).await?;
    let id = state.ssh.next_id();
    let info = ConnectionInfo {
        id: id.clone(),
        host: profile.normalized_host(),
        port: profile.port,
        username: profile.username.clone(),
        name: profile.name.clone(),
        label: profile.label(),
        connected_at: now_iso(),
    };
    let session = Arc::new(Session {
        info: info.clone(),
        handle,
        fingerprint: fingerprint.clone(),
        make_sftp_lock: tokio::sync::Mutex::new(()),
    });
    state.ssh.insert(session);
    Ok(json!({ "connection": info, "fingerprint": fingerprint }))
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let terminals: Vec<String> = {
        let map = state.ssh.terminals.lock().unwrap();
        map.iter()
            .filter(|(_, t)| t.session_id == id)
            .map(|(k, _)| k.clone())
            .collect()
    };
    for term in terminals {
        if let Some(handle) = state.ssh.terminals.lock().unwrap().remove(&term) {
            let _ = handle.tx.send(TerminalCommand::Close);
        }
    }
    let removed = { state.ssh.sessions.lock().unwrap().remove(&id) };
    if let Some(session) = removed {
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "bye", "en")
            .await;
    }
    Ok(json!({ "status": "disconnected" }))
}

#[tauri::command]
pub fn ssh_list(state: State<'_, AppState>) -> AppResult<Value> {
    Ok(json!({ "connections": state.ssh.list() }))
}

#[tauri::command]
pub async fn ssh_status(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    Ok(json!({
        "connected": !session.handle.is_closed(),
        "connection": session.info,
        "fingerprint": session.fingerprint,
    }))
}

#[tauri::command]
pub async fn ssh_time(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let (_, output) = ssh::exec_collect(&session.handle, remote::time_command(), 15_000).await?;
    let digits: String = output.chars().filter(|c| c.is_ascii_digit()).collect();
    let millis: i64 = digits.parse().unwrap_or(0);
    Ok(json!({ "time": millis }))
}

#[tauri::command]
pub async fn ssh_metrics(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let (code, output) = ssh::exec_collect(&session.handle, remote::metrics_command(), 30_000).await?;
    if code != 0 {
        return Err(AppError::internal(format!("指标采集失败（退出码 {code}）")));
    }
    let mut map = remote::parse_metrics(&output);
    map.insert("collectedAt".into(), json!(now_iso()));
    Ok(Value::Object(map.into_iter().collect()))
}

#[tauri::command]
pub async fn ssh_reboot(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let command = remote::reboot_command();
    let handle = session.handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = ssh::exec_collect(&handle, command, 5_000).await;
    });
    Ok(json!({ "status": "rebooting" }))
}

#[tauri::command]
pub async fn ssh_exec(state: State<'_, AppState>, id: String, command: String) -> AppResult<Value> {
    if command.trim().is_empty() {
        return Err(AppError::validation("command is required"));
    }
    let session = state.ssh.get(&id)?;
    let (code, output) = ssh::exec_collect(&session.handle, &command, 30_000).await?;
    Ok(json!({ "exitCode": code, "output": output }))
}

#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    term_id: String,
    screen_name: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sender = ssh::open_terminal(
        app,
        session,
        term_id.clone(),
        screen_name,
        cols.unwrap_or(120),
        rows.unwrap_or(30),
    )
    .await?;
    state.ssh.terminals.lock().unwrap().insert(
        term_id.clone(),
        ssh::TerminalHandle {
            tx: sender,
            session_id: id,
        },
    );
    Ok(json!({ "termId": term_id, "status": "connected" }))
}

#[tauri::command]
pub fn term_input(state: State<'_, AppState>, term_id: String, data: String) -> AppResult<()> {
    let map = state.ssh.terminals.lock().unwrap();
    let handle = map
        .get(&term_id)
        .ok_or_else(|| AppError::new("TERM_NOT_FOUND", "终端已关闭"))?;
    handle
        .tx
        .send(TerminalCommand::Input(data.into_bytes()))
        .map_err(|_| AppError::new("TERM_NOT_FOUND", "终端已关闭"))
}

#[tauri::command]
pub fn term_resize(state: State<'_, AppState>, term_id: String, cols: u32, rows: u32) -> AppResult<()> {
    let map = state.ssh.terminals.lock().unwrap();
    let handle = map
        .get(&term_id)
        .ok_or_else(|| AppError::new("TERM_NOT_FOUND", "终端已关闭"))?;
    handle
        .tx
        .send(TerminalCommand::Resize(cols.max(1), rows.max(1)))
        .map_err(|_| AppError::new("TERM_NOT_FOUND", "终端已关闭"))
}

#[tauri::command]
pub fn term_close(state: State<'_, AppState>, term_id: String) -> AppResult<()> {
    if let Some(handle) = state.ssh.terminals.lock().unwrap().remove(&term_id) {
        let _ = handle.tx.send(TerminalCommand::Close);
    }
    Ok(())
}

#[tauri::command]
pub async fn files_list(state: State<'_, AppState>, id: String, path: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sftp = sftp::open_sftp(&session).await?;
    let entries = sftp::list_dir(&sftp, &path).await?;
    let _ = sftp.close().await;
    Ok(json!({ "path": path, "files": entries }))
}

#[tauri::command]
pub async fn files_read(state: State<'_, AppState>, id: String, path: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sftp = sftp::open_sftp(&session).await?;
    let (content, size) = sftp::read_text_file(&sftp, &path).await?;
    let _ = sftp.close().await;
    Ok(json!({ "path": path, "content": content, "size": size }))
}

#[tauri::command]
pub async fn files_write(state: State<'_, AppState>, id: String, path: String, content: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sftp = sftp::open_sftp(&session).await?;
    sftp::write_text_file(&sftp, &path, &content).await?;
    let _ = sftp.close().await;
    Ok(json!({ "ok": true, "path": path }))
}

#[tauri::command]
pub async fn files_operation(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    action: String,
    path: String,
    destination: Option<String>,
    paths: Option<Vec<String>>,
    content: Option<String>,
    mode: Option<String>,
    kind: Option<String>,
    name: Option<String>,
) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    match action.as_str() {
        "compress" | "extract" => {
            let dest = destination
                .clone()
                .ok_or_else(|| AppError::validation("destination must be an absolute non-root path"))?;
            if !dest.starts_with('/') || dest == "/" {
                return Err(AppError::validation("destination must be an absolute non-root path"));
            }
            let (command, tool) = if action == "compress" {
                let mut sources = paths.unwrap_or_default();
                sources.retain(|p| !p.trim().is_empty());
                if sources.is_empty() {
                    sources = vec![path.clone()];
                }
                if sources.is_empty() || sources.len() > 200 {
                    return Err(AppError::validation("paths must contain between 1 and 200 entries"));
                }
                remote::compress_command(&sources, &dest)?
            } else {
                remote::extract_command(&path, &dest)?
            };
            let missing = ensure_tools(&session, &[tool.to_string()]).await?;
            if !missing.is_empty() {
                return Err(AppError::new(
                    "REMOTE_TOOL_MISSING",
                    format!("远程服务器缺少工具：{}", missing.join(", ")),
                ));
            }
            let job_kind = action.clone();
            let job_id = state.jobs.create(&job_kind);
            let job_id_ret = job_id.clone();
            let handle = session.handle.clone();
            let jobs = state.jobs_handle();
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                jobs.update(&job_id, "running", None);
                let _ = app_handle.emit("file-job", json!({ "jobId": job_id, "status": "running" }));
                match ssh::exec_collect(&handle, &command, 1_800_000).await {
                    Ok((code, output)) => {
                        if code == 0 {
                            jobs.update(&job_id, "completed", None);
                        } else {
                            let msg = if output.trim().is_empty() {
                                format!("命令以退出码 {code} 结束")
                            } else {
                                output.trim().to_string()
                            };
                            jobs.update(&job_id, "failed", Some(msg));
                        }
                    }
                    Err(e) => jobs.update(&job_id, "failed", Some(e.message)),
                }
                let _ = app_handle.emit("file-job", json!({ "jobId": job_id, "status": "done" }));
            });
            Ok(json!({ "jobId": job_id_ret, "status": "queued", "type": job_kind }))
        }
        _ => {
            let sftp = sftp::open_sftp(&session).await?;
            let result = async {
                match action.as_str() {
                    "mkdir" => sftp.create_dir(path.clone()).await.map_err(|e| AppError::sftp(e.to_string())),
                    "create" => {
                        let text = content.clone().unwrap_or_default();
                        sftp::write_text_file(&sftp, &path, &text).await
                    }
                    "write" => {
                        let text = content.clone().unwrap_or_default();
                        sftp::write_text_file(&sftp, &path, &text).await
                    }
                    "rename" | "move" => {
                        let dest = destination
                            .clone()
                            .ok_or_else(|| AppError::validation("destination is required"))?;
                        sftp.rename(path.clone(), dest).await.map_err(|e| AppError::sftp(e.to_string()))
                    }
                    "delete" => sftp::remove_recursive(&sftp, &path).await,
                    "copy" => {
                        let dest = destination
                            .clone()
                            .ok_or_else(|| AppError::validation("destination is required"))?;
                        sftp::copy_recursive(&sftp, &path, &dest).await
                    }
                    "chmod" => {
                        let mode = mode.clone().unwrap_or_default();
                        if !(mode.len() == 3 || mode.len() == 4) || !mode.chars().all(|c| ('0'..='7').contains(&c)) {
                            return Err(AppError::validation("mode must contain 3 or 4 octal digits"));
                        }
                        let value = u32::from_str_radix(&mode, 8)
                            .map_err(|_| AppError::validation("mode must contain 3 or 4 octal digits"))?;
                        let mut attrs = russh_sftp::protocol::FileAttributes::default();
                        attrs.permissions = Some(value);
                        sftp.set_metadata(path.clone(), attrs)
                            .await
                            .map_err(|e| AppError::sftp(e.to_string()))
                    }
                    "desktop-shortcut" => {
                        let kind = kind.clone().unwrap_or_default();
                        if kind != "file" && kind != "directory" {
                            return Err(AppError::validation("type must be file or directory"));
                        }
                        create_desktop_shortcut(&sftp, &path, &kind, name.clone()).await
                    }
                    other => Err(AppError::new(
                        "UNSUPPORTED_OPERATION",
                        format!("不支持的文件操作：{other}"),
                    )),
                }
            }
            .await;
            let _ = sftp.close().await;
            result?;
            Ok(json!({ "ok": true, "action": action, "path": path }))
        }
    }
}

async fn ensure_tools(session: &Arc<Session>, tools: &[String]) -> AppResult<Vec<String>> {
    let command = remote::tool_inspect_command(tools);
    let (_, output) = ssh::exec_collect(&session.handle, &command, 20_000).await?;
    let status = remote::parse_tool_status(&output, tools);
    Ok(status.missing)
}

const MAX_SHORTCUT_FILE_BYTES: u64 = 64 * 1024;

async fn create_desktop_shortcut(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    kind: &str,
    name: Option<String>,
) -> AppResult<()> {
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|e| AppError::sftp(e.to_string()))?;
    let dir = format!("{}/.webssh/desktop", home.trim_end_matches('/'));
    prepare_dir(sftp, &format!("{}/.webssh", home.trim_end_matches('/'))).await?;
    prepare_dir(sftp, &dir).await?;
    let label = match name {
        Some(v) if !v.trim().is_empty() => v,
        _ => remote::base_of(path),
    };
    let file = format!("{}/{}.webssh-link", dir, sftp::sanitize_name(&label));
    let payload = json!({
        "version": 1,
        "kind": "remote-shortcut",
        "name": label,
        "target": path,
        "targetType": kind,
    });
    sftp::write_text_file(sftp, &file, &payload.to_string()).await?;
    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.permissions = Some(0o600);
    let _ = sftp.set_metadata(file, attrs).await;
    Ok(())
}

async fn prepare_dir(sftp: &russh_sftp::client::SftpSession, dir: &str) -> AppResult<()> {
    match sftp.metadata(dir.to_string()).await {
        Ok(attrs) => {
            if !attrs.is_dir() {
                return Err(AppError::new("NOT_A_DIRECTORY", format!("{dir} 不是目录")));
            }
        }
        Err(_) => {
            sftp.create_dir(dir.to_string())
                .await
                .map_err(|e| AppError::sftp(e.to_string()))?;
            let mut attrs = russh_sftp::protocol::FileAttributes::default();
            attrs.permissions = Some(0o700);
            let _ = sftp.set_metadata(dir.to_string(), attrs).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_list(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sftp = sftp::open_sftp(&session).await?;
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|e| AppError::sftp(e.to_string()))?;
    let home_dir = home.trim_end_matches('/').to_string();
    prepare_dir(&sftp, &format!("{home_dir}/.webssh")).await?;
    let dir = format!("{home_dir}/.webssh/desktop");
    prepare_dir(&sftp, &dir).await?;
    let mut entries = sftp::list_dir(&sftp, &dir).await?;
    for entry in entries.iter_mut() {
        if entry.kind != "file" || !entry.name.ends_with(".webssh-link") {
            continue;
        }
        if entry.size > MAX_SHORTCUT_FILE_BYTES {
            continue;
        }
        let Ok(content) = sftp.read(entry.path.clone()).await else { continue };
        let Ok(text) = String::from_utf8(content) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        let target = value.get("target").and_then(|v| v.as_str()).unwrap_or("").trim();
        let target_type = value.get("targetType").and_then(|v| v.as_str()).unwrap_or("");
        if target.is_empty() || (target_type != "file" && target_type != "directory") {
            continue;
        }
        let label = value
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| entry.name.trim_end_matches(".webssh-link"));
        entry.shortcut_path = Some(entry.path.clone());
        entry.target = Some(target.to_string());
        entry.target_type = Some(target_type.to_string());
        entry.kind = "shortcut".into();
        entry.name = label.to_string();
    }
    let _ = sftp.close().await;
    Ok(json!({ "home": home_dir, "dir": dir, "files": entries }))
}

#[tauri::command]
pub async fn files_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
    remote_path: String,
) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sftp = sftp::open_sftp(&session).await?;
    let target = std::path::PathBuf::from(&path);
    let size = sftp::download_to_path(&sftp, &remote_path, &target).await?;
    let _ = sftp.close().await;
    let _ = app.emit("download-complete", json!({ "path": path }));
    Ok(json!({ "ok": true, "size": size, "path": path }))
}

#[tauri::command]
pub async fn files_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let sftp = sftp::open_sftp(&session).await?;
    let mut uploaded = Vec::new();
    for local in local_paths {
        let local_path = std::path::PathBuf::from(&local);
        let name = local_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| "upload.bin".into());
        let remote = sftp::join_path(&remote_dir, &name);
        let app_handle = app.clone();
        let tracked = remote.clone();
        let size = sftp::upload_from_path(&sftp, &local_path, &remote, move |written| {
            let _ = app_handle.emit("upload-progress", json!({ "path": tracked, "written": written }));
        })
        .await?;
        uploaded.push(json!({ "path": remote, "size": size }));
    }
    let _ = sftp.close().await;
    Ok(json!({ "files": uploaded }))
}

#[tauri::command]
pub async fn screen_list(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let (_, output) = ssh::exec_collect(&session.handle, remote::screen_list_command(), 15_000).await?;
    let names = remote::screen_names_from(&output);
    let mut sessions = Vec::new();
    for name in names {
        let (_, label) = ssh::exec_collect(
            &session.handle,
            &remote::screen_read_meta_command(&name, "label"),
            10_000,
        )
        .await
        .unwrap_or((0, String::new()));
        let (_, path) = ssh::exec_collect(
            &session.handle,
            &remote::screen_read_meta_command(&name, "path"),
            10_000,
        )
        .await
        .unwrap_or((0, String::new()));
        let path = path.trim().to_string();
        let mut label = label.trim().to_string();
        if label.is_empty() {
            label = if path.is_empty() {
                "Screen".into()
            } else {
                remote::base_of(&path)
            };
        }
        sessions.push(ScreenSession {
            name,
            label,
            path,
            started_at: now_iso(),
        });
    }
    Ok(json!({ "sessions": sessions }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRequest {
    pub action: Option<String>,
    pub name: Option<String>,
    pub path: Option<String>,
    pub label: Option<String>,
    pub auto_exit: Option<bool>,
}

#[tauri::command]
pub async fn screen_create(state: State<'_, AppState>, id: String, request: ScreenRequest) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    if request.action.as_deref() == Some("kill") {
        let name = request.name.clone().unwrap_or_default();
        if !remote::valid_screen_name(&name) {
            return Err(AppError::new("INVALID_SCREEN_SESSION", "Screen 会话名称无效"));
        }
        let _ = ssh::exec_collect(&session.handle, &remote::screen_kill_command(&name), 15_000).await;
        return Ok(json!({ "status": "closed", "name": name }));
    }

    let path = request.path.clone().unwrap_or_default();
    let path = path.trim().to_string();
    if !path.is_empty() {
        let sftp = sftp::open_sftp(&session).await?;
        let attrs = sftp
            .metadata(path.clone())
            .await
            .map_err(|_| AppError::new("NOT_EXECUTABLE", "目标文件不存在或无法访问"))?;
        if attrs.is_dir() {
            let _ = sftp.close().await;
            return Err(AppError::new("NOT_EXECUTABLE", "目录不能直接运行"));
        }
        let mode = attrs.permissions.unwrap_or(0);
        if mode & 0o111 == 0 {
            let _ = sftp.close().await;
            return Err(AppError::new("NOT_EXECUTABLE", "文件没有执行权限"));
        }
        let _ = sftp.close().await;
    }

    let auto_exit = request.auto_exit.unwrap_or(true);
    let label = if path.is_empty() {
        remote::safe_label(request.label.as_deref().unwrap_or(""))
    } else {
        remote::base_of(&path)
    };
    let name = remote::random_screen_name();
    let command = remote::screen_create_command(&name, &label, &path, auto_exit);
    let result = ssh::exec_collect(&session.handle, &command, 15_000).await;
    if result.is_err() {
        let (_, output) = ssh::exec_collect(&session.handle, remote::screen_list_command(), 10_000)
            .await
            .unwrap_or((0, String::new()));
        if !output.contains(&format!(".{name}")) {
            return Err(AppError::new("SCREEN_START_FAILED", "Screen 会话启动失败"));
        }
    }
    Ok(json!({
        "name": name,
        "label": label,
        "path": path,
        "startedAt": now_iso(),
    }))
}

#[tauri::command]
pub async fn tools_inspect(state: State<'_, AppState>, id: String, tools: Option<Vec<String>>) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    let requested = match tools {
        Some(list) if !list.is_empty() => list,
        _ => remote::TOOL_WHITELIST.iter().map(|v| v.to_string()).collect(),
    };
    for tool in &requested {
        if !remote::TOOL_WHITELIST.contains(&tool.as_str()) {
            return Err(AppError::validation(format!("不支持的远程工具：{tool}")));
        }
    }
    let (_, output) = ssh::exec_collect(&session.handle, &remote::tool_inspect_command(&requested), 20_000).await?;
    let status: ToolStatus = remote::parse_tool_status(&output, &requested);
    to_value(status)
}

#[tauri::command]
pub async fn tools_install(state: State<'_, AppState>, id: String, tools: Vec<String>) -> AppResult<Value> {
    let session = state.ssh.get(&id)?;
    for tool in &tools {
        if !remote::TOOL_WHITELIST.contains(&tool.as_str()) {
            return Err(AppError::validation(format!("不支持的远程工具：{tool}")));
        }
    }
    let (_, inspect_output) =
        ssh::exec_collect(&session.handle, &remote::tool_inspect_command(&tools), 20_000).await?;
    let before = remote::parse_tool_status(&inspect_output, &tools);
    if before.missing.is_empty() {
        return to_value(before);
    }
    let command = before
        .install_command
        .clone()
        .ok_or_else(|| AppError::new("PACKAGE_MANAGER_NOT_FOUND", "远程服务器上未找到支持的包管理器"))?;
    let (code, output) = ssh::exec_collect(&session.handle, &command, 1_800_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "REMOTE_TOOL_INSTALL_FAILED",
            if output.trim().is_empty() { format!("安装失败（退出码 {code}）") } else { output.trim().to_string() },
        ));
    }
    let (_, after_output) =
        ssh::exec_collect(&session.handle, &remote::tool_inspect_command(&tools), 20_000).await?;
    let after = remote::parse_tool_status(&after_output, &tools);
    if !after.missing.is_empty() {
        return Err(AppError::new(
            "REMOTE_TOOL_INSTALL_FAILED",
            format!("安装结束后仍缺少工具：{}", after.missing.join(", ")),
        ));
    }
    to_value(after)
}

#[tauri::command]
pub fn file_job(state: State<'_, AppState>, job_id: String) -> AppResult<Value> {
    state
        .jobs
        .get(&job_id)
        .map(|job| to_value(job))
        .unwrap_or_else(|| Err(AppError::new("FILE_JOB_NOT_FOUND", "文件任务不存在")))
}

#[tauri::command]
pub async fn terminal_screen_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    term_id: String,
    name: String,
) -> AppResult<Value> {
    if !remote::valid_screen_name(&name) {
        return Err(AppError::new("INVALID_SCREEN_SESSION", "Screen 会话名称无效"));
    }
    term_open(app, state, id, term_id, Some(name), Some(120), Some(30)).await
}

pub fn command_handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        ssh_test,
        ssh_connect,
        ssh_disconnect,
        ssh_list,
        ssh_status,
        ssh_time,
        ssh_metrics,
        ssh_reboot,
        ssh_exec,
        term_open,
        term_input,
        term_resize,
        term_close,
        files_list,
        files_read,
        files_write,
        files_operation,
        files_download,
        files_upload,
        desktop_list,
        screen_list,
        screen_create,
        tools_inspect,
        tools_install,
        file_job,
        terminal_screen_attach,
        crate::commands_sysadmin::firewall_status,
        crate::commands_sysadmin::firewall_action,
        crate::commands_sysadmin::mirror_status,
        crate::commands_sysadmin::mirror_apply,
        crate::commands_sysadmin::time_status,
        crate::commands_sysadmin::time_action,
        crate::commands_sysadmin::timezone_status,
        crate::commands_sysadmin::timezone_set,
        crate::commands_sysadmin::services_list,
        crate::commands_sysadmin::service_action,
        crate::commands_sysadmin::service_create,
        crate::commands_sysadmin::processes_list,
        crate::commands_sysadmin::process_kill,
        crate::commands_sysadmin::performance_snapshot
    ]
}

