use serde::{Deserialize, Serialize};

/// 统一的错误负载，前端据此展示与判定。
#[derive(Debug, Serialize, Clone)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("VALIDATION_ERROR", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", message)
    }
    pub fn ssh(message: impl Into<String>) -> Self {
        Self::new("SSH_ERROR", message)
    }
    pub fn sftp(message: impl Into<String>) -> Self {
        Self::new("SFTP_ERROR", message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("IO_ERROR", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::io(e.to_string())
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::ssh(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::sftp(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default = "default_auth")]
    pub auth_method: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default)]
    pub name: String,
}

fn default_port() -> u16 { 22 }
fn default_auth() -> String { "password".into() }

impl ConnectionProfile {
    pub fn normalized_host(&self) -> String {
        let host = self.host.trim();
        if host.starts_with('[') && host.ends_with(']') && host.len() > 2 {
            host[1..host.len() - 1].to_string()
        } else {
            host.to_string()
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.host.trim().is_empty() || self.username.trim().is_empty() {
            return Err(AppError::validation("host and username are required"));
        }
        if self.port == 0 {
            return Err(AppError::validation("port must be between 1 and 65535"));
        }
        match self.auth_method.as_str() {
            "password" => {
                if self.password.is_empty() {
                    return Err(AppError::validation("password is required"));
                }
            }
            "key" => {
                if self.private_key.trim().is_empty() {
                    return Err(AppError::validation("privateKey is required"));
                }
            }
            _ => return Err(AppError::validation("authMethod must be password or key")),
        }
        Ok(())
    }

    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            format!("{}@{}", self.username, self.normalized_host())
        } else {
            self.name.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub value: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub name: String,
    pub label: String,
    pub connected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub permissions: String,
    pub owner: String,
    pub group: String,
    pub modified: u64,
    /// 桌面快捷方式指向的真实路径（普通文件为空）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// 快捷方式目标类型：file / directory。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_type: Option<String>,
    /// 快捷方式链接文件自身的路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSession {
    pub name: String,
    pub label: String,
    pub path: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJob {
    pub job_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub processed: u64,
    pub total: u64,
    pub percent: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    format_iso(secs, millis)
}

pub fn format_iso(secs: i64, millis: u32) -> String {
    // 无第三方依赖的 UTC 格式化：civil_from_days 算法
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, m, d, h, mi, s, millis)
}

/// 单引号安全的 shell 参数转义。
pub fn shq(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}
