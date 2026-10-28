mod commands;
mod commands_sysadmin;
pub mod harness;
pub mod model;
pub mod remote;
pub mod sftp;
mod ssh;
pub mod sysadmin;

use std::sync::Arc;

use tauri::Manager;

use commands::command_handlers;
use model::FileJob;
use remote::FileJobs;
use ssh::SshManager;

pub struct AppState {
    pub ssh: Arc<SshManager>,
    pub jobs: Arc<FileJobs>,
}

impl AppState {
    pub fn jobs_handle(&self) -> Arc<FileJobs> {
        self.jobs.clone()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState {
            ssh: Arc::new(SshManager::default()),
            jobs: Arc::new(FileJobs::default()),
        })
        .invoke_handler(command_handlers())
        .setup(|app| {
            #[cfg(desktop)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("TauriSSH");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[allow(dead_code)]
fn keep_types(_: FileJob) {}
