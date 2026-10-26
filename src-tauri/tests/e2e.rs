//! 端到端集成测试：连接本机 sshd（127.0.0.1:2222），验证 SSH、SFTP、命令、Screen 与监控解析。
//!
//! 运行方式：
//!   TEST_SSH_KEY=/tmp/testssh/id_ed25519 TEST_SSH_PORT=2222 TEST_SSH_USER=mac cargo test --test e2e -- --test-threads=1
//!
//! 未提供 TEST_SSH_KEY 时全部用例自动跳过，保证 CI 默认不依赖外部服务。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use taurissh_lib::harness::{self, TestProfile};

/// 优先使用私钥（TEST_SSH_KEY），否则退回密码（TEST_SSH_PASSWORD）；两者都未提供时跳��。
fn profile() -> Option<TestProfile> {
    let password = std::env::var("TEST_SSH_PASSWORD").ok().filter(|v| !v.is_empty());
    let private_key = std::env::var("TEST_SSH_KEY")
        .ok()
        .filter(|path| PathBuf::from(path).exists())
        .map(|path| std::fs::read_to_string(path).unwrap())
        .unwrap_or_default();

    if private_key.is_empty() && password.is_none() {
        return None;
    }

    Some(TestProfile {
        host: std::env::var("TEST_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("TEST_SSH_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2222),
        username: std::env::var("TEST_SSH_USER").unwrap_or_else(|_| "mac".into()),
        private_key,
        passphrase: std::env::var("TEST_SSH_PASSPHRASE").ok(),
        password,
        use_password: std::env::var("TEST_SSH_KEY").is_err() || std::env::var("TEST_SSH_PASSWORD").is_ok(),
    })
}

macro_rules! require_profile {
    () => {
        match profile() {
            Some(p) => p,
            None => {
                eprintln!("跳过：未设置 TEST_SSH_KEY");
                return;
            }
        }
    };
}

#[tokio::test]
async fn ssh_connect_and_fingerprint() {
    let p = require_profile!();
    let (handle, fingerprint) = harness::connect(&p).await.expect("连接失败");
    assert!(fingerprint.value.starts_with("SHA256:"), "指纹格式异常: {}", fingerprint.value);
    assert!(!fingerprint.algorithm.is_empty());
    let (code, output) = harness::exec(&handle, "echo hello-taurissh", 15_000).await.expect("命令失败");
    assert_eq!(code, 0);
    assert!(output.contains("hello-taurissh"));
    let _ = handle.disconnect(Disconnect::ByApplication, "done", "en").await;
}

#[tokio::test]
async fn ssh_wrong_password_is_rejected_or_fails_cleanly() {
    let mut p = require_profile!();
    p.password = Some("definitely-wrong-password".into());
    p.private_key = String::new();
    p.passphrase = None;
    p.use_password = true;
    let result = harness::connect_password(&p).await;
    assert!(result.is_err(), "错误密码不应连接成功");
}

#[tokio::test]
async fn terminal_channel_streams_output() {
    let p = require_profile!();
    let (handle, _) = harness::connect(&p).await.expect("连接失败");
    let output = harness::run_shell_command(&handle, "echo tty-test; sleep 0.2; exit\n").await;
    assert!(output.contains("tty-test"), "终端输出缺少预期内容: {output}");
    let _ = handle.disconnect(Disconnect::ByApplication, "done", "en").await;
}

#[tokio::test]
async fn sftp_roundtrip_create_read_rename_delete() {
    let p = require_profile!();
    let (handle, _) = harness::connect(&p).await.expect("连接失败");
    let sftp = harness::open_sftp(&handle).await.expect("SFTP 打开失败");

    let base = format!("/tmp/taurissh-test-{}", std::process::id());
    let file = format!("{base}.txt");
    let renamed = format!("{base}.md");

    harness::sftp_write(&sftp, &file, "hello sftp").await.expect("写入失败");
    let content = harness::sftp_read(&sftp, &file).await.expect("读取失败");
    assert_eq!(content, "hello sftp");

    let (code, _) = harness::exec(&handle, &format!("ls -l {}", file), 15_000).await.unwrap();
    assert_eq!(code, 0, "文件应存在于远端");

    sftp.rename(file.clone(), renamed.clone()).await.expect("重命名失败");
    sftp.remove_file(renamed.clone()).await.expect("删除失败");
    let _ = sftp.close().await;
    let _ = handle.disconnect(Disconnect::ByApplication, "done", "en").await;
}

#[tokio::test]
async fn sftp_list_directory_returns_entries() {
    let p = require_profile!();
    let (handle, _) = harness::connect(&p).await.expect("连接失败");
    let sftp = harness::open_sftp(&handle).await.expect("SFTP 打开失败");
    let entries = harness::sftp_list(&sftp, "/tmp").await.expect("列目录失败");
    assert!(!entries.is_empty(), "/tmp 应有内容");
    assert!(entries.iter().all(|(name, _)| name != "." && name != ".."), "列目录结果不应包含 . 与 ..");
    let _ = sftp.close().await;
    let _ = handle.disconnect(Disconnect::ByApplication, "done", "en").await;
}

#[tokio::test]
async fn metrics_command_parses_on_macos_or_linux() {
    let p = require_profile!();
    let (handle, _) = harness::connect(&p).await.expect("连接失败");
    let (code, output) = harness::exec(&handle, "printf 'cpu=1.5\\nhostname=test\\n'", 10_000)
        .await
        .expect("命令失败");
    assert_eq!(code, 0);
    let parsed = taurissh_lib::remote::parse_metrics(&output);
    assert_eq!(parsed.get("cpu").and_then(|v| v.as_f64()), Some(1.5));
    assert_eq!(parsed.get("hostname").and_then(|v| v.as_str()), Some("test"));
    let _ = handle.disconnect(Disconnect::ByApplication, "done", "en").await;
}

#[tokio::test]
async fn screen_name_validation_and_generation() {
    let name = taurissh_lib::remote::random_screen_name();
    assert!(taurissh_lib::remote::valid_screen_name(&name), "生成的名称应合法: {name}");
    assert!(!taurissh_lib::remote::valid_screen_name("webssh-XYZ"));
    let parsed = taurissh_lib::remote::screen_names_from(
        "There are screens on:\n\t12345.webssh-abcdef123456\t(Detached)\n2 Sockets in /run/screen.\n",
    );
    assert_eq!(parsed, vec!["webssh-abcdef123456".to_string()]);
}

#[tokio::test]
async fn shell_quoting_is_injection_safe() {
    let quoted = taurissh_lib::model::shq("a'b; rm -rf /tmp/nope");
    assert_eq!(quoted, "'a'\"'\"'b; rm -rf /tmp/nope'");
}

#[tokio::test]
async fn compress_and_extract_commands_are_well_formed() {
    let (cmd, tool) = taurissh_lib::remote::compress_command(&["/tmp/a".into()], "/tmp/o.tar.gz").unwrap();
    assert_eq!(tool, "tar");
    assert!(cmd.contains("tar -czf '/tmp/o.tar.gz'"));
    assert!(cmd.contains("tar -czf '/tmp/o.tar.gz' -C '/tmp' './a'"), "tar 参数顺序错误: {cmd}");
    assert!(!cmd.contains("; -C"), "tar 参数间不能有分号: {cmd}");

    let (cmd, tool) = taurissh_lib::remote::extract_command("/tmp/o.zip", "/tmp/out").unwrap();
    assert_eq!(tool, "unzip");
    assert!(cmd.contains("unzip -oq '/tmp/o.zip' -d "));

    assert!(taurissh_lib::remote::compress_command(&["/tmp/a".into()], "/tmp/o.rar").is_err());
}

#[tokio::test]
async fn sftp_chunked_upload_with_progress() {
    let p = require_profile!();
    let (handle, _) = harness::connect(&p).await.expect("连接失败");
    let sftp = harness::open_sftp(&handle).await.expect("SFTP 打开失败");
    let local = std::env::temp_dir().join(format!("taurissh-upload-{}.bin", std::process::id()));
    let payload = vec![7u8; 300 * 1024];
    std::fs::write(&local, &payload).unwrap();

    let mut seen = 0u64;
    let written = harness::sftp_upload(&sftp, &local, "/tmp/taurissh-upload.bin", |n| seen = n)
        .await
        .expect("上传失败");
    assert_eq!(written, payload.len() as u64);
    assert_eq!(seen, payload.len() as u64, "进度回调应报告完整字节数");

    let (code, output) = harness::exec(&handle, "wc -c < /tmp/taurissh-upload.bin", 15_000).await.unwrap();
    assert_eq!(code, 0);
    assert_eq!(output.trim(), payload.len().to_string());

    let _ = harness::exec(&handle, "rm -f /tmp/taurissh-upload.bin", 10_000).await;
    std::fs::remove_file(local).ok();
    let _ = sftp.close().await;
    let _ = handle.disconnect(Disconnect::ByApplication, "done", "en").await;
}

#[allow(dead_code)]
fn assert_send<T: Send>() {}

#[allow(dead_code)]
fn typecheck() {
    assert_send::<Arc<Handle<AcceptAny>>>();
    assert_send::<SftpSession>();
    let _ = Duration::from_secs(1);
    let _ = client::Config::default();
}

#[derive(Clone)]
struct AcceptAny;

impl russh::client::Handler for AcceptAny {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::test]
async fn terminal_open_sends_initial_output() {
    let p = require_profile!();
    let (handle, _) = harness::connect(&p).await.expect("连接失败");
    let output = harness::run_shell_command(&handle, "echo FIRST_FRAME_OK; sleep 0.3; exit\n").await;
    assert!(output.contains("FIRST_FRAME_OK"), "PTY 首帧应包含命令输出，实际: {output:?}");
}
