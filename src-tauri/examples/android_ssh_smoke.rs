//! Android 真机 SSH/SFTP 冒烟测试：与 App 共用同一套 Rust 实现。
use taurissh_lib::harness::{self, TestProfile};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let host = args.get(1).cloned().unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(2222);
    let user = args.get(3).cloned().unwrap_or_else(|| "mac".into());
    let key_path = args.get(4).cloned().unwrap_or_else(|| "/data/local/tmp/id_ed25519".into());

    let key = std::fs::read_to_string(&key_path).expect("读取私钥失败");
    let profile = TestProfile {
        host: host.clone(),
        port,
        username: user.clone(),
        private_key: key,
        passphrase: None,
        password: None,
    };

    println!("[1] 连接 {user}@{host}:{port}");
    let (handle, _fp) = match harness::connect(&profile).await {
        Ok(v) => v,
        Err(e) => {
            println!("FAIL 连接失败: {e:?}");
            std::process::exit(1);
        }
    };
    println!("OK  SSH 连接成功");

    let (code, out) = harness::exec(&handle, "echo ANDROID_SSH_OK; uname -a", 20_000).await.expect("exec");
    assert_eq!(code, 0);
    println!("OK  远程命令: {}", out.trim().replace('\n', " | "));
    assert!(out.contains("ANDROID_SSH_OK"));

    println!("[2] 打开 SFTP 子系统");
    let sftp = harness::open_sftp(&handle).await.expect("sftp");
    println!("OK  SFTP 已打开");

    let path = "/tmp/taurissh-android-smoke.txt";
    harness::sftp_write(&sftp, path, "hello from android").await.expect("write");
    let back = harness::sftp_read(&sftp, path).await.expect("read");
    assert_eq!(back, "hello from android");
    println!("OK  SFTP 写入/读取往返一致");

    let entries = harness::sftp_list(&sftp, "/tmp").await.expect("list");
    println!("OK  列目录 /tmp 共 {} 项", entries.len());

    let (code, _) = harness::exec(&handle, &format!("rm -f {path}"), 10_000).await.unwrap();
    assert_eq!(code, 0);
    let _ = sftp.close().await;

    println!("[3] 交互式 PTY 终端");
    let out = harness::run_shell_command(&handle, "echo PTY_ANDROID_OK; exit\\n").await;
    assert!(out.contains("PTY_ANDROID_OK"), "PTY 输出: {out}");
    println!("OK  PTY 通道可交互");

    println!("ALL_ANDROID_CHECKS_PASSED");
}
