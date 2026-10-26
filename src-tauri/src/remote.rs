use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::*;

pub const TOOL_WHITELIST: [&str; 5] = ["screen", "tar", "gzip", "zip", "unzip"];
const SHELL_LOGIN: &str = "exec \"${SHELL:-/bin/sh}\" -l";

pub fn metrics_command() -> &'static str {
    r#"LC_ALL=C; export LC_ALL; cpu1=$(awk '/^cpu /{idle=$5+$6; total=$2+$3+$4+idle+$7+$8+$9; print idle,total}' /proc/stat); sleep 1; cpu2=$(awk '/^cpu /{idle=$5+$6; total=$2+$3+$4+idle+$7+$8+$9; print idle,total}' /proc/stat); set -- $cpu1; idle1=$1; total1=$2; set -- $cpu2; idle2=$1; total2=$2; awk -v i1=$idle1 -v t1=$total1 -v i2=$idle2 -v t2=$total2 'BEGIN{dt=t2-t1; printf "cpu=%.1f\n",dt ? 100*(1-(i2-i1)/dt) : 0}'; free -b | awk '/^Mem:/{printf "memory=%.1f\nmemoryTotal=%.0f\nmemoryUsed=%.0f\nmemoryAvailable=%.0f\n",$2?100*$3/$2:0,$2,$3,$7} /^Swap:/{printf "swap=%.1f\nswapTotal=%.0f\nswapUsed=%.0f\n",$2?100*$3/$2:0,$2,$3}'; df -PB1 / | awk 'NR==2{gsub(/%/,"",$5); print "disk="$5"\ndiskTotal="$2"\ndiskUsed="$3"\ndiskAvailable="$4}'; awk '{print "load="$1" "$2" "$3}' /proc/loadavg; awk 'NR>2{rx+=$2;tx+=$10} END{print "download="rx"\nupload="tx}' /proc/net/dev; awk '{print "uptime="int($1)}' /proc/uptime; awk -F: '/^model name/{gsub(/^[ \t]+/,"",$2); print "cpuModel="$2; exit}' /proc/cpuinfo; awk '/^processor/{n++} END{print "cpuCores="n}' /proc/cpuinfo; printf 'hostname='; hostname; printf 'kernel='; uname -sr; printf 'processes='; ps -e 2>/dev/null | awk 'NR>1{n++} END{print n+0}'"#
}

pub fn time_command() -> &'static str {
    "date +%s%3N 2>/dev/null || date +%s000"
}

pub fn reboot_command() -> &'static str {
    "shutdown -r now 2>/dev/null || systemctl reboot"
}

pub fn tool_inspect_command(tools: &[String]) -> String {
    let mut parts: Vec<String> = vec!["printf 'uid=%s\\n' \"$(id -u)\"".into()];
    for tool in tools {
        parts.push(format!(
            "command -v {tool} >/dev/null 2>&1 && echo '{tool}=1' || echo '{tool}=0'"
        ));
    }
    parts.push(
        "for p in apt-get dnf yum apk pacman zypper; do command -v $p >/dev/null 2>&1 && { echo manager=$p; break; }; done".into(),
    );
    parts.join("; ")
}

pub fn install_command_for(package_manager: &str, tools: &[String], sudo: bool) -> Option<String> {
    let prefix = if sudo { "sudo -n " } else { "" };
    let packages = tools.join(" ");
    match package_manager {
        "apt-get" => Some(format!("{prefix}apt-get update && {prefix}apt-get install -y {packages}")),
        "dnf" => Some(format!("{prefix}dnf install -y {packages}")),
        "yum" => Some(format!("{prefix}yum install -y {packages}")),
        "apk" => Some(format!("{prefix}apk add --no-cache {packages}")),
        "pacman" => Some(format!("{prefix}pacman -Sy --noconfirm {packages}")),
        "zypper" => Some(format!("{prefix}zypper --non-interactive install {packages}")),
        _ => None,
    }
}

pub fn screen_list_command() -> &'static str {
    "screen -ls 2>/dev/null || true"
}

pub fn screen_create_command(name: &str, label: &str, path: &str, auto_exit: bool) -> String {
    let script = if path.is_empty() {
        SHELL_LOGIN.to_string()
    } else {
        let tail = if auto_exit {
            "exit \"$status\"".to_string()
        } else {
            SHELL_LOGIN.to_string()
        };
        format!(
            "cd {} && {}; status=$?; printf '\\n[taurissh] program exited with status: %s\\n' \"$status\"; {}",
            shq(&parent_of(path)),
            shq(path),
            tail
        )
    };
    format!(
        "mkdir -p \"$HOME/.webssh/screen-sessions\" && printf '%s' {} > \"$HOME/.webssh/screen-sessions/{name}.path\" && printf '%s' {} > \"$HOME/.webssh/screen-sessions/{name}.label\" && screen -DmS {} sh -lc {} </dev/null >/dev/null 2>&1",
        shq(path),
        shq(label),
        shq(name),
        shq(&script)
    )
}

pub fn screen_read_meta_command(name: &str, kind: &str) -> String {
    format!("cat \"$HOME/.webssh/screen-sessions/{name}.{kind}\" 2>/dev/null || true")
}

pub fn screen_kill_command(name: &str) -> String {
    format!(
        "screen -S {} -X quit 2>/dev/null || true; rm -f \"$HOME/.webssh/screen-sessions/{name}.path\" \"$HOME/.webssh/screen-sessions/{name}.label\"",
        shq(name)
    )
}

pub fn tar_stream_command(path: &str) -> String {
    let base = base_of(path);
    let source = if base.is_empty() { ".".to_string() } else { format!("./{base}") };
    format!("tar -czf - -C {} {}", shq(&parent_of(path)), shq(&source))
}

pub fn compress_command(sources: &[String], destination: &str) -> AppResult<(String, &'static str)> {
    if destination.ends_with(".tar.gz") || destination.ends_with(".tgz") {
        // 拼接为：tar -czf <dest> -C <parent1> './base1' -C <parent2> './base2'
        let mut tar = format!("tar -czf {}", shq(destination));
        for source in sources {
            tar.push_str(&format!(
                " -C {} {}",
                shq(&parent_of(source)),
                shq(&format!("./{}", base_of(source)))
            ));
        }
        let command = format!("set -e; rm -f {}; {}", shq(destination), tar);
        Ok((command, "tar"))
    } else if destination.ends_with(".zip") {
        let mut parts = vec!["set -e".to_string(), format!("rm -f {}", shq(destination))];
        for source in sources {
            parts.push(format!(
                "(cd {} && zip -rq {} {})",
                shq(&parent_of(source)),
                shq(destination),
                shq(&format!("./{}", base_of(source)))
            ));
        }
        Ok((format!("{};", parts.join("; ")), "zip"))
    } else if destination.ends_with(".gz") {
        if sources.len() != 1 {
            return Err(AppError::new("GZIP_REQUIRES_FILE", "GZIP 只能压缩单个文件"));
        }
        let command = format!(
            "set -e; rm -f {dest}; gzip -c -- {src} > {dest}",
            dest = shq(destination),
            src = shq(&sources[0])
        );
        Ok((command, "gzip"))
    } else {
        Err(AppError::new("UNSUPPORTED_ARCHIVE_FORMAT", "压缩包必须以 .zip、.tar.gz、.tgz 或 .gz 结尾"))
    }
}

pub fn extract_command(archive: &str, destination: &str) -> AppResult<(String, &'static str)> {
    let temp = format!("{destination}.webssh-extract-{}", uuid::Uuid::new_v4());
    if archive.ends_with(".tar.gz") || archive.ends_with(".tgz") {
        let command = format!(
            "set -e; tar -tzf {arc} >/dev/null; rm -rf {temp}; mkdir -p {temp}; tar -xzf {arc} -C {temp}; test \"$(du -sk {temp} | awk '{{print $1}}')\" -le 2097152; if [ -e {dest} ]; then cp -a {temp}/. {dest}/; rm -rf {temp}; else mv {temp} {dest}; fi",
            arc = shq(archive),
            temp = shq(&temp),
            dest = shq(destination)
        );
        Ok((command, "tar"))
    } else if archive.ends_with(".zip") {
        let command = format!(
            "set -e; unzip -Z1 {arc} >/dev/null; rm -rf {temp}; mkdir -p {temp}; unzip -oq {arc} -d {temp}; test \"$(du -sk {temp} | awk '{{print $1}}')\" -le 2097152; if [ -e {dest} ]; then cp -a {temp}/. {dest}/; rm -rf {temp}; else mv {temp} {dest}; fi",
            arc = shq(archive),
            temp = shq(&temp),
            dest = shq(destination)
        );
        Ok((command, "unzip"))
    } else if archive.ends_with(".gz") {
        let name = base_of(archive);
        let output = name.strip_suffix(".gz").unwrap_or("");
        if output.is_empty() {
            return Err(AppError::new("INVALID_ARCHIVE", "GZIP 文件没有有效的输出文件名"));
        }
        let target = format!("{}/{}", destination.trim_end_matches('/'), output);
        let temp = format!("{target}.webssh-extract-{}", uuid::Uuid::new_v4());
        let command = format!(
            "set -e; gzip -t -- {arc}; mkdir -p {dest}; rm -f {temp}; gzip -dc -- {arc} | head -c 2147483649 > {temp}; test \"$(wc -c < {temp})\" -le 2147483648; mv -f {temp} {target}",
            arc = shq(archive),
            dest = shq(destination),
            temp = shq(&temp),
            target = shq(&target)
        );
        Ok((command, "gzip"))
    } else {
        Err(AppError::new("UNSUPPORTED_ARCHIVE_FORMAT", "压缩包必须以 .zip、.tar.gz、.tgz 或 .gz 结尾"))
    }
}

pub fn parent_of(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".into();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(idx) => trimmed[..idx].to_string(),
        None => "/".into(),
    }
}

pub fn base_of(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(idx) => trimmed[idx + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

pub fn parse_metrics(output: &str) -> HashMap<String, Value> {
    let mut map = HashMap::new();
    for line in output.lines() {
        let Some(idx) = line.find('=') else { continue };
        let key = line[..idx].trim().to_string();
        let raw = line[idx + 1..].trim();
        if key.is_empty() || map.contains_key(&key) {
            continue;
        }
        let value = match raw.parse::<f64>() {
            Ok(num) => serde_json::json!(num),
            Err(_) => serde_json::json!(raw),
        };
        map.insert(key, value);
    }
    map
}

pub fn screen_names_from(output: &str) -> Vec<String> {
    let mut names = Vec::new();
    for segment in output.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        if let Some((prefix, rest)) = segment.split_once('.') {
            if !prefix.is_empty()
                && prefix.chars().all(|c| c.is_ascii_digit())
                && rest.starts_with("webssh-")
                && rest.len() == "webssh-".len() + 12
                && rest["webssh-".len()..].chars().all(|c| c.is_ascii_hexdigit())
            {
                names.push(rest.to_string());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

pub fn random_screen_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let pid = std::process::id() as u64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let mut state = nanos ^ (pid << 32) ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut out = String::from("webssh-");
    for _ in 0..12 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let digit = ((state >> 33) % 16) as u32;
        out.push(std::char::from_digit(digit, 16).unwrap());
    }
    out
}

pub fn valid_screen_name(name: &str) -> bool {
    name.len() == "webssh-".len() + 12
        && name.starts_with("webssh-")
        && name["webssh-".len()..].chars().all(|c| c.is_ascii_hexdigit())
}

pub fn safe_label(value: &str) -> String {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Screen".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub tools: HashMap<String, bool>,
    pub missing: Vec<String>,
    pub package_manager: String,
    pub requires_sudo: bool,
    pub can_install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
}

pub fn parse_tool_status(output: &str, requested: &[String]) -> ToolStatus {
    let mut tools = HashMap::new();
    let mut package_manager = String::new();
    let mut uid = String::new();
    for line in output.lines() {
        if let Some(v) = line.strip_prefix("uid=") {
            uid = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("manager=") {
            package_manager = v.trim().to_string();
        } else if let Some((name, value)) = line.split_once('=') {
            if requested.iter().any(|t| t == name) {
                tools.insert(name.to_string(), value.trim() == "1");
            }
        }
    }
    for tool in requested {
        tools.entry(tool.clone()).or_insert(false);
    }
    let missing: Vec<String> = requested
        .iter()
        .filter(|t| !tools.get(*t).copied().unwrap_or(false))
        .cloned()
        .collect();
    let requires_sudo = !uid.is_empty() && uid != "0";
    let can_install = !package_manager.is_empty();
    let install_command = if !missing.is_empty() && can_install {
        install_command_for(&package_manager, &missing, requires_sudo)
    } else {
        None
    };
    ToolStatus {
        tools,
        missing,
        package_manager,
        requires_sudo,
        can_install,
        install_command,
    }
}

#[derive(Default)]
pub struct FileJobs {
    pub jobs: StdMutex<HashMap<String, FileJob>>,
}

impl FileJobs {
    pub fn create(&self, kind: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let job = FileJob {
            job_id: id.clone(),
            kind: kind.to_string(),
            status: "queued".into(),
            processed: 0,
            total: 0,
            percent: 0,
            error: None,
        };
        self.jobs.lock().unwrap().insert(id.clone(), job);
        id
    }

    pub fn update(&self, id: &str, status: &str, error: Option<String>) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(id) {
            job.status = status.to_string();
            job.error = error;
            if status == "completed" {
                job.percent = 100;
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<FileJob> {
        self.jobs.lock().unwrap().get(id).cloned()
    }
}
