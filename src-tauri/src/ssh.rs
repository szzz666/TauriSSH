use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use russh::client::{self, Handle};
use russh::keys::ssh_key::HashAlg;
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use crate::model::*;

pub struct ClientHandler {
    pub fingerprint: Arc<StdMutex<Option<Fingerprint>>>,
    pub host: String,
    pub port: u16,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let (value, algorithm) = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => (
                key.fingerprint(HashAlg::Sha256).to_string(),
                key.algorithm().as_str().to_string(),
            ),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => (
                cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
                cert.public_key().algorithm().as_str().to_string(),
            ),
        };
        if let Ok(mut slot) = self.fingerprint.lock() {
            *slot = Some(Fingerprint {
                host: self.host.clone(),
                port: self.port,
                algorithm,
                value,
                changed: false,
            });
        }
        Ok(true)
    }
}

pub struct Session {
    pub info: ConnectionInfo,
    pub handle: Arc<Handle<ClientHandler>>,
    pub fingerprint: Fingerprint,
    pub make_sftp_lock: Mutex<()>,
}

pub struct TerminalHandle {
    pub tx: mpsc::UnboundedSender<TerminalCommand>,
    pub session_id: String,
}

pub enum TerminalCommand {
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Default)]
pub struct SshManager {
    pub sessions: StdMutex<HashMap<String, Arc<Session>>>,
    pub terminals: StdMutex<HashMap<String, TerminalHandle>>,
    pub counter: AtomicU64,
}

impl SshManager {
    pub fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        format!("sess-{:x}-{:x}", std::process::id(), n)
    }

    pub fn insert(&self, session: Arc<Session>) {
        self.sessions.lock().unwrap().insert(session.info.id.clone(), session);
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("CONNECTION_NOT_FOUND", "连接不存在或已过期"))
    }

    pub fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    pub fn list(&self) -> Vec<ConnectionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.clone())
            .collect()
    }
}

pub async fn connect_and_authenticate(profile: &ConnectionProfile) -> AppResult<(Arc<Handle<ClientHandler>>, Fingerprint)> {
    profile.validate()?;
    let host = profile.normalized_host();
    let fingerprint_slot = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        fingerprint: fingerprint_slot.clone(),
        host: host.clone(),
        port: profile.port,
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        ..Default::default()
    });
    let mut handle = client::connect(config, (host.clone(), profile.port), handler)
        .await
        .map_err(|e| AppError::new("SSH_CONNECTION_FAILED", format!("SSH 连接失败：{e}")))?;

    let auth_ok = match profile.auth_method.as_str() {
        "key" => {
            let passphrase = if profile.passphrase.is_empty() { None } else { Some(profile.passphrase.clone()) };
            let key = russh::keys::decode_secret_key(profile.private_key.trim(), passphrase.as_deref())
                .map_err(|e| AppError::new("INVALID_PRIVATE_KEY", format!("私钥解析失败：{e}")))?;
            let key = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(profile.username.clone(), key)
                .await
                .map_err(|e| AppError::new("AUTHENTICATION_FAILED", format!("SSH 身份验证失败：{e}")))?
                .success()
        }
        _ => handle
            .authenticate_password(profile.username.clone(), profile.password.clone())
            .await
            .map_err(|e| AppError::new("AUTHENTICATION_FAILED", format!("SSH 身份验证失败：{e}")))?
            .success(),
    };

    if !auth_ok {
        let _ = handle.disconnect(Disconnect::ByApplication, "auth failed", "en").await;
        return Err(AppError::new("AUTHENTICATION_FAILED", "SSH 身份验证失败"));
    }

    let fingerprint = fingerprint_slot
        .lock()
        .unwrap()
        .clone()
        .unwrap_or(Fingerprint {
            host: host.clone(),
            port: profile.port,
            algorithm: "unknown".into(),
            value: "未知".into(),
            changed: false,
        });

    Ok((Arc::new(handle), fingerprint))
}

/// 执行命令并收集 stdout+stderr，返回 (退出码, 输出文本)。
pub async fn exec_collect(handle: &Handle<ClientHandler>, command: &str, timeout_ms: u64) -> AppResult<(u32, String)> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;
    let mut output: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let mut exit_code = 0u32;

    let result = tokio::time::timeout_at(deadline, async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => output.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => output.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;

    match result {
        Ok(_) => Ok((exit_code, String::from_utf8_lossy(&output).to_string())),
        Err(_) => Err(AppError::new("TIMEOUT", "远程命令执行超时")),
    }
}

/// 启动一个 shell 终端：可选的 screen 会话名。
#[allow(clippy::too_many_arguments)]
pub async fn open_terminal(
    app: AppHandle,
    session: Arc<Session>,
    term_id: String,
    screen_name: Option<String>,
    cols: u32,
    rows: u32,
) -> AppResult<mpsc::UnboundedSender<TerminalCommand>> {
    let mut channel = session.handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;

    if let Some(name) = screen_name.clone() {
        let command = format!("exec screen -x {}\r", shq(&name));
        channel.data(command.as_bytes()).await?;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<TerminalCommand>();
    let event_channel = format!("terminal://{}", term_id);
    let app_handle = app.clone();
    let term_for_task = term_id.clone();

    tauri::async_runtime::spawn(async move {
        let _ = app_handle.emit(&event_channel, TerminalEvent { kind: "status", data: Some("connected".into()), code: None });
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let payload = TerminalEvent {
                                kind: "output",
                                data: Some(base64_encode(data)),
                                code: None,
                            };
                            let _ = app_handle.emit(&event_channel, payload);
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let payload = TerminalEvent {
                                kind: "output",
                                data: Some(base64_encode(data)),
                                code: None,
                            };
                            let _ = app_handle.emit(&event_channel, payload);
                        }
                        Some(ChannelMsg::ExitStatus { .. }) => {}
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            let _ = app_handle.emit(&event_channel, TerminalEvent {
                                kind: "status",
                                data: Some("closed".into()),
                                code: None,
                            });
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(TerminalCommand::Input(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(TerminalCommand::Resize(c, r)) => {
                            let _ = channel.window_change(c.max(1), r.max(1), 0, 0).await;
                        }
                        Some(TerminalCommand::Close) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
            }
        }
        let _ = app_handle.emit(&event_channel, TerminalEvent {
            kind: "closed",
            data: Some(term_for_task),
            code: None,
        });
    });

    Ok(tx)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub kind: &'static str,
    pub data: Option<String>,
    pub code: Option<String>,
}

pub fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

