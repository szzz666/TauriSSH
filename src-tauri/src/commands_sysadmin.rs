//! 服务器运维相关命令：防火墙、软件源、时间同步、时区、systemd 服务、进程与性能。

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::model::*;
use crate::ssh;
use crate::sysadmin;
use crate::AppState;

/// 统一的「执行脚本 + 返回 stdout」封装。
async fn run(state: &State<'_, AppState>, id: &str, command: &str, timeout_ms: u64) -> AppResult<(u32, String)> {
    let session = state.ssh.get(id)?;
    ssh::exec_collect(&session.handle, command, timeout_ms).await
}

#[tauri::command]
pub async fn firewall_status(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, output) = run(&state, &id, sysadmin::firewall_status_command(), 30_000).await?;
    let status = sysadmin::parse_firewall(&output);
    Ok(serde_json::to_value(status).map_err(|e| AppError::internal(e.to_string()))?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallRequest {
    pub action: String,
    #[serde(default)]
    pub spec: String,
    #[serde(default)]
    pub policy: String,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub rule_action: String,
}

#[tauri::command]
pub async fn firewall_action(state: State<'_, AppState>, id: String, request: FirewallRequest) -> AppResult<Value> {
    let command = sysadmin::firewall_action_command(&sysadmin::FirewallAction {
        action: request.action.clone(),
        spec: request.spec.clone(),
        policy: request.policy.clone(),
        backend: request.backend.clone(),
        rule_action: request.rule_action.clone(),
    })?;
    let (code, output) = run(&state, &id, &command, 180_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "FIREWALL_ACTION_FAILED",
            if output.trim().is_empty() {
                format!("防火墙操作失败（退出码 {code}）")
            } else {
                output.trim().to_string()
            },
        ));
    }
    let (_, status_output) = run(&state, &id, sysadmin::firewall_status_command(), 30_000).await?;
    Ok(json!({
        "ok": true,
        "output": output.trim(),
        "status": sysadmin::parse_firewall(&status_output),
    }))
}

#[tauri::command]
pub async fn mirror_status(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, output) = run(&state, &id, sysadmin::mirror_status_command(), 30_000).await?;
    Ok(serde_json::to_value(sysadmin::parse_mirror_status(&output))
        .map_err(|e| AppError::internal(e.to_string()))?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRequest {
    pub mirror: String,
}

#[tauri::command]
pub async fn mirror_apply(state: State<'_, AppState>, id: String, request: MirrorRequest) -> AppResult<Value> {
    let (_, status_output) = run(&state, &id, sysadmin::mirror_status_command(), 30_000).await?;
    let status = sysadmin::parse_mirror_status(&status_output);
    if !status.can_write {
        return Err(AppError::new("PERMISSION_DENIED", "需要 root 权限或免密 sudo 才能修改软件源"));
    }
    let command = sysadmin::mirror_apply_command(&request.mirror, &status)?;
    let (code, output) = run(&state, &id, &command, 600_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "MIRROR_APPLY_FAILED",
            if output.trim().is_empty() { format!("切换镜像源失败（退出码 {code}）") } else { output.trim().to_string() },
        ));
    }
    let (_, after) = run(&state, &id, sysadmin::mirror_status_command(), 30_000).await?;
    Ok(json!({
        "ok": true,
        "output": output.trim(),
        "status": sysadmin::parse_mirror_status(&after),
    }))
}

#[tauri::command]
pub async fn time_status(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, output) = run(&state, &id, sysadmin::time_status_command(), 30_000).await?;
    Ok(serde_json::to_value(sysadmin::parse_time_status(&output))
        .map_err(|e| AppError::internal(e.to_string()))?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRequest {
    pub action: String,
    #[serde(default)]
    pub servers: Vec<String>,
}

#[tauri::command]
pub async fn time_action(state: State<'_, AppState>, id: String, request: TimeRequest) -> AppResult<Value> {
    let command = sysadmin::time_action_command(&sysadmin::TimeSyncAction {
        action: request.action.clone(),
        servers: request.servers.clone(),
    })?;
    let (code, output) = run(&state, &id, &command, 300_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "TIME_ACTION_FAILED",
            if output.trim().is_empty() { format!("时间同步操作失败（退出码 {code}）") } else { output.trim().to_string() },
        ));
    }
    let (_, after) = run(&state, &id, sysadmin::time_status_command(), 30_000).await?;
    Ok(json!({
        "ok": true,
        "output": output.trim(),
        "status": sysadmin::parse_time_status(&after),
    }))
}

#[tauri::command]
pub async fn timezone_status(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, output) = run(&state, &id, sysadmin::timezone_status_command(), 40_000).await?;
    Ok(serde_json::to_value(sysadmin::parse_timezone_status(&output))
        .map_err(|e| AppError::internal(e.to_string()))?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimezoneRequest {
    pub timezone: String,
}

#[tauri::command]
pub async fn timezone_set(state: State<'_, AppState>, id: String, request: TimezoneRequest) -> AppResult<Value> {
    let command = sysadmin::timezone_set_command(&request.timezone)?;
    let (code, output) = run(&state, &id, &command, 60_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "TIMEZONE_SET_FAILED",
            if output.trim().is_empty() { "设置时区失败".to_string() } else { output.trim().to_string() },
        ));
    }
    let (_, after) = run(&state, &id, sysadmin::timezone_status_command(), 40_000).await?;
    Ok(json!({
        "ok": true,
        "output": output.trim(),
        "status": sysadmin::parse_timezone_status(&after),
    }))
}

#[tauri::command]
pub async fn services_list(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, output) = run(&state, &id, sysadmin::services_command(), 60_000).await?;
    let list = sysadmin::parse_services(&output);
    Ok(json!({ "services": list }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRequest {
    pub unit: String,
    pub action: String,
}

#[tauri::command]
pub async fn service_action(state: State<'_, AppState>, id: String, request: ServiceRequest) -> AppResult<Value> {
    let command = sysadmin::service_action_command(&request.unit, &request.action)?;
    let (_, output) = run(&state, &id, &command, 120_000).await?;
    Ok(json!({ "ok": true, "output": output.trim() }))
}

#[tauri::command]
pub async fn service_create(
    state: State<'_, AppState>,
    id: String,
    request: sysadmin::ServiceCreateRequest,
) -> AppResult<Value> {
    let command = sysadmin::service_create_command(&request)?;
    let (code, output) = run(&state, &id, &command, 120_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "SERVICE_CREATE_FAILED",
            if output.trim().is_empty() {
                format!("创建服务失败（退出码 {code}）")
            } else {
                output.trim().to_string()
            },
        ));
    }
    Ok(json!({ "ok": true, "output": output.trim() }))
}

#[tauri::command]
pub async fn processes_list(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, output) = run(&state, &id, sysadmin::process_list_command(), 30_000).await?;
    Ok(json!({ "processes": sysadmin::parse_processes(&output) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillRequest {
    pub pid: u32,
    #[serde(default)]
    pub signal: String,
}

#[tauri::command]
pub async fn process_kill(state: State<'_, AppState>, id: String, request: KillRequest) -> AppResult<Value> {
    let command = sysadmin::kill_process_command(request.pid, &request.signal)?;
    let (code, output) = run(&state, &id, &command, 30_000).await?;
    if code != 0 {
        return Err(AppError::new(
            "KILL_FAILED",
            if output.trim().is_empty() { format!("结束进程失败（退出码 {code}）") } else { output.trim().to_string() },
        ));
    }
    Ok(json!({ "ok": true, "output": output.trim() }))
}

#[tauri::command]
pub async fn performance_snapshot(state: State<'_, AppState>, id: String) -> AppResult<Value> {
    let (_, process_output) = run(&state, &id, sysadmin::process_list_command(), 20_000).await?;
    let process_count = sysadmin::parse_processes(&process_output).len() as u64;
    let (code, output) = run(&state, &id, sysadmin::performance_command(), 30_000).await?;
    if code != 0 {
        return Err(AppError::internal(format!("性能采集失败（退出码 {code}）")));
    }
    Ok(serde_json::to_value(sysadmin::parse_performance(&output, process_count))
        .map_err(|e| AppError::internal(e.to_string()))?)
}
