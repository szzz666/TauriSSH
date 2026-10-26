use std::path::Path;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::model::*;
use crate::ssh::Session;

pub async fn open_sftp(session: &Arc<Session>) -> AppResult<SftpSession> {
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let stream = channel.into_stream();
    let sftp = SftpSession::new(stream).await?;
    Ok(sftp)
}

pub fn permissions_string(attrs: &russh_sftp::protocol::FileAttributes) -> String {
    let mode = attrs.permissions.unwrap_or(0);
    let kind = if attrs.is_dir() {
        'd'
    } else if attrs.is_symlink() {
        'l'
    } else if attrs.is_character() {
        'c'
    } else if attrs.is_block() {
        'b'
    } else if attrs.is_fifo() {
        'p'
    } else {
        '-'
    };
    let bits = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    let mut out = String::with_capacity(10);
    out.push(kind);
    for (mask, ch) in bits {
        out.push(if mode & mask != 0 { ch } else { '-' });
    }
    out
}

pub fn kind_of(attrs: &russh_sftp::protocol::FileAttributes, file_type: Option<FileType>) -> String {
    if attrs.is_dir() || matches!(file_type, Some(FileType::Dir)) {
        "directory".into()
    } else if attrs.is_symlink() || matches!(file_type, Some(FileType::Symlink)) {
        "symlink".into()
    } else {
        "file".into()
    }
}

pub fn join_path(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub async fn list_dir(sftp: &SftpSession, path: &str) -> AppResult<Vec<RemoteFile>> {
    let mut entries = Vec::new();
    let read_dir = sftp.read_dir(path.to_string()).await?;
    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs = entry.metadata();
        let full = join_path(path, &name);
        let size = attrs.size.unwrap_or(0);
        entries.push(RemoteFile {
            name: name.clone(),
            path: full,
            kind: kind_of(&attrs, Some(entry.file_type())),
            size,
            permissions: permissions_string(&attrs),
            owner: attrs.uid.map(|v| v.to_string()).unwrap_or_default(),
            group: attrs.gid.map(|v| v.to_string()).unwrap_or_default(),
            modified: attrs.mtime.map(|v| v as u64).unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| {
        let da = a.kind == "directory";
        let db = b.kind == "directory";
        db.cmp(&da).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn read_text_file(sftp: &SftpSession, path: &str) -> AppResult<(String, u64)> {
    const MAX: u64 = 2 * 1024 * 1024;
    let attrs = sftp.metadata(path.to_string()).await?;
    if attrs.is_dir() {
        return Err(AppError::new("NOT_A_FILE", "目录不能在文本编辑器中打开"));
    }
    let size = attrs.size.unwrap_or(0);
    if size > MAX {
        return Err(AppError::new("FILE_TOO_LARGE", "文本编辑器仅支持不超过 2 MiB 的文件"));
    }
    let mut file = sftp.open(path.to_string()).await?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await?;
    if buf.contains(&0u8) {
        return Err(AppError::new("BINARY_FILE", "二进制文件不能在文本编辑器中打开"));
    }
    let text = String::from_utf8(buf)
        .map_err(|_| AppError::new("UNSUPPORTED_ENCODING", "仅支持 UTF-8 编码的文本文件"))?;
    let len = text.len() as u64;
    Ok((text, len))
}

pub async fn write_text_file(sftp: &SftpSession, path: &str, content: &str) -> AppResult<()> {
    const MAX: usize = 2 * 1024 * 1024;
    if content.len() > MAX {
        return Err(AppError::new("FILE_TOO_LARGE", "文本编辑器仅支持不超过 2 MiB 的文件"));
    }
    let mut file = sftp.create(path.to_string()).await?;
    file.write_all(content.as_bytes()).await?;
    file.flush().await?;
    let _ = file.sync_all().await;
    Ok(())
}

pub async fn remove_recursive(sftp: &SftpSession, path: &str) -> AppResult<()> {
    let attrs = sftp.symlink_metadata(path.to_string()).await?;
    if attrs.is_dir() {
        let entries = list_dir(sftp, path).await?;
        for entry in entries {
            Box::pin(remove_recursive(sftp, &entry.path)).await?;
        }
        sftp.remove_dir(path.to_string()).await?;
    } else {
        sftp.remove_file(path.to_string()).await?;
    }
    Ok(())
}

pub async fn copy_recursive(sftp: &SftpSession, source: &str, destination: &str) -> AppResult<()> {
    let attrs = sftp.symlink_metadata(source.to_string()).await?;
    if attrs.is_dir() {
        if sftp.try_exists(destination.to_string()).await.unwrap_or(false) {
            let dattrs = sftp.metadata(destination.to_string()).await?;
            if !dattrs.is_dir() {
                return Err(AppError::new("INVALID_DESTINATION", "目标位置已存在同名文件"));
            }
        } else {
            sftp.create_dir(destination.to_string()).await?;
        }
        let entries = list_dir(sftp, source).await?;
        for entry in entries {
            let target = join_path(destination, &entry.name);
            Box::pin(copy_recursive(sftp, &entry.path, &target)).await?;
        }
    } else {
        let mut file = sftp.open(source.to_string()).await?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).await?;
        let mut out = sftp.create(destination.to_string()).await?;
        out.write_all(&buf).await?;
        out.flush().await?;
        let _ = out.sync_all().await;
    }
    Ok(())
}

pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "shortcut".into()
    } else if trimmed.chars().count() > 200 {
        trimmed.chars().take(200).collect()
    } else {
        trimmed.to_string()
    }
}

/// 把远端文件安全下载到本地临时目录（用于编辑/预览）。
pub async fn download_to_path(sftp: &SftpSession, remote: &str, local: &Path) -> AppResult<u64> {
    let mut file = sftp.open(remote.to_string()).await?;
    let mut out = tokio::fs::File::create(local).await?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    out.flush().await?;
    Ok(total)
}

/// 上传本地文件到远端（覆盖写），带进度回调。
pub async fn upload_from_path<F>(sftp: &SftpSession, local: &Path, remote: &str, mut progress: F) -> AppResult<u64>
where
    F: FnMut(u64),
{
    let mut file = tokio::fs::File::open(local).await?;
    let mut out = sftp.create(remote.to_string()).await?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).await?;
        total += n as u64;
        progress(total);
    }
    out.flush().await?;
    let _ = out.sync_all().await;
    Ok(total)
}

