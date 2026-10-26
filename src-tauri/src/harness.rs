//! 供集成测试使用的可复用封装：暴露 SSH/SFTP 基础能力，避免测试直接依赖私有实现。

use std::sync::Arc;

use russh::client::{self, Handle};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;

pub use crate::model::*;
pub use crate::remote;

pub struct TestProfile {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key: String,
    pub passphrase: Option<String>,
    pub password: Option<String>,
    /// true 时使用密码认证，否则使用私钥。
    pub use_password: bool,
}

pub struct AcceptAll;

impl client::Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect_with(profile: &TestProfile, use_key: bool) -> AppResult<(Arc<Handle<AcceptAll>>, Fingerprint)> {
    let config = Arc::new(client::Config::default());
    let mut handle = client::connect(config, (profile.host.clone(), profile.port), AcceptAll)
        .await
        .map_err(|e| AppError::new("SSH_CONNECTION_FAILED", e.to_string()))?;

    let ok = if use_key {
        let key = russh::keys::decode_secret_key(&profile.private_key, profile.passphrase.as_deref())
            .map_err(|e| AppError::new("INVALID_PRIVATE_KEY", e.to_string()))?;
        let key = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
        handle
            .authenticate_publickey(profile.username.clone(), key)
            .await
            .map_err(|e| AppError::new("AUTHENTICATION_FAILED", e.to_string()))?
            .success()
    } else {
        handle
            .authenticate_password(profile.username.clone(), profile.password.clone().unwrap_or_default())
            .await
            .map_err(|e| AppError::new("AUTHENTICATION_FAILED", e.to_string()))?
            .success()
    };

    if !ok {
        return Err(AppError::new("AUTHENTICATION_FAILED", "SSH 身份验证失败"));
    }

    Ok((
        Arc::new(handle),
        Fingerprint {
            host: profile.host.clone(),
            port: profile.port,
            algorithm: "test".into(),
            value: "SHA256:test".into(),
            changed: false,
        },
    ))
}

pub async fn connect(profile: &TestProfile) -> AppResult<(Arc<Handle<AcceptAll>>, Fingerprint)> {
    connect_with(profile, !profile.use_password).await
}

pub async fn connect_password(profile: &TestProfile) -> AppResult<(Arc<Handle<AcceptAll>>, Fingerprint)> {
    connect_with(profile, false).await
}

pub async fn exec(handle: &Handle<AcceptAll>, command: &str, timeout_ms: u64) -> AppResult<(u32, String)> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;
    let mut output = Vec::new();
    let mut code = 0u32;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let _ = tokio::time::timeout_at(deadline, async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => output.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => output.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;
    Ok((code, String::from_utf8_lossy(&output).to_string()))
}

/// 在 PTY shell 中执行一条命令，用于验证交互式终端通道。
pub async fn run_shell_command(handle: &Handle<AcceptAll>, script: &str) -> String {
    let mut channel = handle.channel_open_session().await.expect("打开 shell 失败");
    channel
        .request_pty(true, "xterm-256color", 120, 30, 0, 0, &[])
        .await
        .expect("请求 PTY 失败");
    channel.request_shell(true).await.expect("请求 shell 失败");
    channel.data(script.as_bytes()).await.expect("写入失败");

    let mut output = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let _ = tokio::time::timeout_at(deadline, async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => output.extend_from_slice(data),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await;
    let _ = channel.close().await;
    String::from_utf8_lossy(&output).to_string()
}

pub async fn open_sftp(handle: &Handle<AcceptAll>) -> AppResult<SftpSession> {
    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let stream = channel.into_stream();
    SftpSession::new(stream).await.map_err(|e| AppError::sftp(e.to_string()))
}

pub async fn sftp_write(sftp: &SftpSession, path: &str, content: &str) -> AppResult<()> {
    crate::sftp::write_text_file(sftp, path, content).await
}

pub async fn sftp_read(sftp: &SftpSession, path: &str) -> AppResult<String> {
    crate::sftp::read_text_file(sftp, path).await.map(|(text, _)| text)
}

pub async fn sftp_list(sftp: &SftpSession, path: &str) -> AppResult<Vec<(String, String)>> {
    let entries = sftp.read_dir(path.to_string()).await.map_err(|e| AppError::sftp(e.to_string()))?;
    Ok(entries
        .map(|e| (e.file_name(), crate::sftp::permissions_string(&e.metadata())))
        .collect())
}

pub async fn sftp_upload<F: FnMut(u64)>(
    sftp: &SftpSession,
    local: &std::path::Path,
    remote: &str,
    progress: F,
) -> AppResult<u64> {
    crate::sftp::upload_from_path(sftp, local, remote, progress).await
}

#[allow(dead_code)]
fn keep(_: Disconnect) {}
