//! 服务器运维能力：防火墙、软件源、时间同步、时区、systemd 开机启动项、进程管理。
//!
//! 所有函数分为「命令构造」与「输出解析」两部分，便于单元测试。

use serde::{Deserialize, Serialize};

use crate::model::{shq, AppError, AppResult};

/// 非 root 时自动加 sudo -n，避免交互式密码提示阻塞。
pub const SUDO_PREFIX: &str = "SUDO=''; [ \"$(id -u)\" = \"0\" ] || SUDO='sudo -n '; ";

fn sudo_checked() -> &'static str {
    SUDO_PREFIX
}

// ============================ 防火墙 ============================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallRule {
    pub to: String,
    pub action: String,
    pub from: String,
    pub v6: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub backend: String,
    pub installed: bool,
    pub active: bool,
    pub default_incoming: String,
    pub default_outgoing: String,
    pub default_routed: String,
    pub rules: Vec<FirewallRule>,
    pub ports: Vec<String>,
    pub services: Vec<String>,
    pub zone: String,
    pub raw: String,
    /// 是否具备修改权限（root 或可免密 sudo）
    pub can_write: bool,
}

pub fn firewall_status_command() -> &'static str {
    r#"if command -v ufw >/dev/null 2>&1; then echo __BACKEND__=ufw; ufw status verbose 2>&1; echo __ADDED__; ufw show added 2>&1; elif command -v firewall-cmd >/dev/null 2>&1; then echo __BACKEND__=firewalld; firewall-cmd --state 2>&1; echo __ZONE__; firewall-cmd --get-default-zone 2>&1; echo __LIST__; firewall-cmd --list-all 2>&1; else echo __BACKEND__=none; fi; echo __SUDO__; { sudo -n true 2>/dev/null && echo 1 || echo 0; }"#
}

pub fn parse_firewall(output: &str) -> FirewallStatus {
    let mut status = FirewallStatus::default();
    let mut section = "";
    let mut body: Vec<&str> = Vec::new();
    let mut added: Vec<String> = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim_end();
        if let Some(value) = trimmed.strip_prefix("__BACKEND__=") {
            status.backend = value.trim().to_string();
        } else if trimmed == "__ADDED__" {
            section = "added";
        } else if trimmed == "__ZONE__" {
            section = "zone";
        } else if trimmed == "__LIST__" {
            section = "list";
        } else if trimmed == "__SUDO__" {
            section = "sudo";
        } else if section == "added" {
            if !trimmed.trim().is_empty() {
                added.push(trimmed.trim().to_string());
            }
        } else if section == "zone" {
            if !trimmed.trim().is_empty() {
                status.zone = trimmed.trim().to_string();
            }
            section = "";
        } else if section == "sudo" {
            // 0 表示可以免密 sudo（非 root），1 表示 root
            if trimmed.trim() == "1" {
                status.can_write = true;
            }
            section = "";
        } else if section == "list" {
            body.push(trimmed);
        } else if !trimmed.trim().is_empty() {
            body.push(trimmed);
        }
    }

    status.installed = status.backend == "ufw" || status.backend == "firewalld";
    status.raw = body.join("\n");

    match status.backend.as_str() {
        "ufw" => {
            parse_ufw(&mut status, &body);
            if !status.active {
                status.rules = parse_ufw_added(&added);
            }
        }
        "firewalld" => parse_firewalld(&mut status, &body),
        _ => {}
    }
    // root 也视为可写
    if !status.can_write {
        status.can_write = output.lines().any(|l| l.trim() == "__SUDO__") && status_detect_root(output);
    }
    status
}

fn status_detect_root(output: &str) -> bool {
    // 解析脚本中 sudo -n true 成功即输出 1；root 直接输出 1——两者都视为可写
    let mut seen_marker = false;
    for line in output.lines() {
        if line.trim() == "__SUDO__" {
            seen_marker = true;
        } else if seen_marker && line.trim() == "1" {
            return true;
        }
    }
    false
}

fn parse_ufw(status: &mut FirewallStatus, body: &[&str]) {
    let mut in_rules = false;
    for line in body {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Status:") {
            status.active = rest.trim().eq_ignore_ascii_case("active");
        } else if let Some(rest) = trimmed.strip_prefix("Default:") {
            for part in rest.split(',') {
                let part = part.trim();
                if part.ends_with("(incoming)") {
                    status.default_incoming = part.replace("(incoming)", "").trim().to_string();
                } else if part.ends_with("(outgoing)") {
                    status.default_outgoing = part.replace("(outgoing)", "").trim().to_string();
                } else if part.ends_with("(routed)") {
                    status.default_routed = part.replace("(routed)", "").trim().to_string();
                }
            }
        } else if trimmed.starts_with("--") || trimmed.starts_with("To ") {
            in_rules = true;
        } else if in_rules && !trimmed.is_empty() {
            if let Some(rule) = parse_ufw_rule(trimmed) {
                status.rules.push(rule);
            }
        }
    }
}

const UFW_ACTIONS: [&str; 8] = [
    "ALLOW IN", "ALLOW OUT", "DENY IN", "DENY OUT", "REJECT IN", "REJECT OUT", "LIMIT IN", "LIMIT OUT",
];

fn parse_ufw_rule(line: &str) -> Option<FirewallRule> {
    for action in UFW_ACTIONS {
        if let Some(idx) = line.find(action) {
            let to_raw = line[..idx].trim();
            let from_raw = line[idx + action.len()..].trim();
            let v6 = to_raw.contains("(v6)") || from_raw.contains("(v6)");
            let to = to_raw
                .replace("(v6)", "")
                .replace("(log)", "")
                .trim()
                .to_string();
            let from = from_raw
                .replace("(v6)", "")
                .replace("(log)", "")
                .trim()
                .to_string();
            if to.is_empty() {
                return None;
            }
            return Some(FirewallRule {
                to,
                action: action.to_string(),
                from,
                v6,
            });
        }
    }
    None
}

fn parse_ufw_added(lines: &[String]) -> Vec<FirewallRule> {
    let mut rules = Vec::new();
    for line in lines {
        let Some(rest) = line.trim().strip_prefix("ufw ") else { continue };
        let tokens: Vec<&str> = rest.split_whitespace().collect();
        if tokens.len() < 2 {
            continue;
        }
        let verb = tokens[0];
        if !matches!(verb, "allow" | "deny" | "reject" | "limit") {
            continue;
        }
        let mut index = 1;
        let mut direction = "IN";
        if matches!(tokens.get(1).copied(), Some("in") | Some("out")) {
            direction = if tokens[1] == "out" { "OUT" } else { "IN" };
            index = 2;
        }
        let spec = tokens.get(index).copied().unwrap_or("");
        if spec.is_empty() || spec == "from" || spec == "to" || spec == "route" {
            continue;
        }
        rules.push(FirewallRule {
            to: spec.to_string(),
            action: format!("{} {}", verb.to_uppercase(), direction),
            from: "Anywhere".into(),
            v6: spec.contains(':'),
        });
    }
    rules
}

fn parse_firewalld(status: &mut FirewallStatus, body: &[&str]) {
    for line in body {
        let trimmed = line.trim();
        if trimmed == "running" || trimmed.eq_ignore_ascii_case("running") {
            status.active = true;
        } else if let Some(rest) = trimmed.strip_prefix("services:") {
            status.services = rest.split_whitespace().map(|s| s.to_string()).collect();
        } else if let Some(rest) = trimmed.strip_prefix("ports:") {
            status.ports = rest.split_whitespace().map(|s| s.to_string()).collect();
        } else if let Some(rest) = trimmed.strip_prefix("target:") {
            status.default_incoming = rest.trim().to_string();
        } else if trimmed.contains("(active)") && status.zone.is_empty() {
            status.zone = trimmed.split_whitespace().next().unwrap_or("").to_string();
        }
    }
}

/// 防火墙变更动作。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallAction {
    pub action: String,
    #[serde(default)]
    pub spec: String,
    #[serde(default)]
    pub policy: String,
    #[serde(default)]
    pub backend: String,
    /// 删除 UFW 规则时使用的原始动作，例如 ALLOW IN / DENY IN。
    #[serde(default)]
    pub rule_action: String,
}

pub fn firewall_action_command(request: &FirewallAction) -> AppResult<String> {
    let action = request.action.as_str();
    let spec = request.spec.trim();
    let body = match action {
        "install" => format!(
            "{}if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update && $SUDO apt-get install -y ufw; elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y firewalld; elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y firewalld; else echo 'NO_PACKAGE_MANAGER'; exit 1; fi", sudo_checked()
        ),
        "enable" => format!(
            "{}if command -v ufw >/dev/null 2>&1; then $SUDO ufw --force enable; elif command -v firewall-cmd >/dev/null 2>&1; then $SUDO systemctl enable --now firewalld; else echo 'NO_FIREWALL'; exit 1; fi", sudo_checked()
        ),
        "disable" => format!(
            "{}if command -v ufw >/dev/null 2>&1; then $SUDO ufw disable; elif command -v firewall-cmd >/dev/null 2>&1; then $SUDO systemctl disable --now firewalld; else echo 'NO_FIREWALL'; exit 1; fi", sudo_checked()
        ),
        "set-defaults" => {
            let (ufw_policy, target) = match request.policy.as_str() {
                "allow" => ("allow incoming", "ACCEPT"),
                "reject" => ("reject incoming", "REJECT"),
                "deny" | "deny (incoming)" | "" => ("deny incoming", "DROP"),
                _ => return Err(AppError::validation("策略必须是 allow、deny 或 reject")),
            };
            format!(
                "{}if command -v ufw >/dev/null 2>&1; then $SUDO ufw default {ufw_policy}; elif command -v firewall-cmd >/dev/null 2>&1; then $SUDO firewall-cmd --permanent --set-target={target} && $SUDO firewall-cmd --reload; else echo 'NO_FIREWALL'; exit 1; fi", sudo_checked()
            )
        }
        "allow" | "deny" | "limit" => {
            if !valid_spec(spec) {
                return Err(AppError::validation("端口或服务名不合法"));
            }
            if request.backend == "firewalld" && action != "allow" {
                return Err(AppError::new(
                    "UNSUPPORTED_BACKEND",
                    "firewalld 模式下暂不支持 deny / limit 规则，请使用默认拒绝策略并仅放行必要端口",
                ));
            }
            let ufw_action = if action == "deny" { "deny" } else if action == "limit" { "limit" } else { "allow" };
            let target = shq(spec);
            format!(
                "{}if command -v ufw >/dev/null 2>&1; then $SUDO ufw {ufw_action} {target}; elif command -v firewall-cmd >/dev/null 2>&1; then {cmd}; else echo 'NO_FIREWALL'; exit 1; fi", sudo_checked(),
                ufw_action = ufw_action,
                target = target,
                cmd = firewalld_add(spec)
            )
        }
        "delete" => {
            if !valid_spec(spec) {
                return Err(AppError::validation("端口或服务名不合法"));
            }
            let target = shq(spec);
            let ufw_verb = match request.rule_action.to_ascii_lowercase().as_str() {
                "deny out" => "deny out",
                "reject out" => "reject out",
                "limit out" => "limit out",
                "allow out" => "allow out",
                "deny in" => "deny",
                "reject in" => "reject",
                "limit in" => "limit",
                _ => "allow",
            };
            format!(
                "{}if command -v ufw >/dev/null 2>&1; then $SUDO ufw --force delete {ufw_verb} {target}; elif command -v firewall-cmd >/dev/null 2>&1; then {cmd}; else echo 'NO_FIREWALL'; exit 1; fi", sudo_checked(),
                ufw_verb = ufw_verb,
                target = target,
                cmd = firewalld_remove(spec)
            )
        }
        other => return Err(AppError::new("UNSUPPORTED_ACTION", format!("不支持的防火墙操作：{other}"))),
    };
    Ok(body)
}

fn firewalld_add(spec: &str) -> String {
    if spec.contains('/') {
        format!(
            "$SUDO firewall-cmd --permanent --add-port={} && $SUDO firewall-cmd --reload",
            shq(spec)
        )
    } else {
        format!(
            "$SUDO firewall-cmd --permanent --add-service={} && $SUDO firewall-cmd --reload",
            shq(spec)
        )
    }
}

fn firewalld_remove(spec: &str) -> String {
    if spec.contains('/') {
        format!(
            "$SUDO firewall-cmd --permanent --remove-port={} && $SUDO firewall-cmd --reload",
            shq(spec)
        )
    } else {
        format!(
            "$SUDO firewall-cmd --permanent --remove-service={} && $SUDO firewall-cmd --reload",
            shq(spec)
        )
    }
}

/// 端口（可逗号分隔）或服务名，例如 22、22/tcp、80,443/tcp、ssh。
pub fn valid_spec(spec: &str) -> bool {
    if spec.is_empty() || spec.len() > 64 {
        return false;
    }
    spec.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '/' | ',' | '-' | '.' | '_' | ':')
    })
}

// ============================ 软件源 ============================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub distro_id: String,
    pub distro_name: String,
    pub codename: String,
    pub version_id: String,
    pub family: String,
    pub package_manager: String,
    pub current_sources: String,
    pub is_mirror: bool,
    pub detected_mirror: String,
    pub can_write: bool,
    pub presets: Vec<MirrorPreset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorPreset {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub active: bool,
}

pub fn mirror_status_command() -> &'static str {
    r#"cat /etc/os-release 2>/dev/null; echo __APT__; cat /etc/apt/sources.list 2>/dev/null; echo __DEB822__; head -60 /etc/apt/sources.list.d/*.sources 2>/dev/null; echo __YUM__; grep -hE '^(mirrorlist|baseurl)=' /etc/yum.repos.d/*.repo 2>/dev/null | head -30; echo __PM__; for p in apt-get dnf yum apk zypper; do command -v $p >/dev/null 2>&1 && { echo $p; break; }; done; echo __SUDO__; { sudo -n true 2>/dev/null && echo 1 || echo 0; }"#
}

pub fn parse_mirror_status(output: &str) -> MirrorStatus {
    let mut status = MirrorStatus::default();
    let mut section = "osrelease";
    let mut apt = Vec::new();
    let mut deb822 = Vec::new();
    let mut yum = Vec::new();

    for line in output.lines() {
        match line.trim() {
            "__APT__" => {
                section = "apt";
                continue;
            }
            "__DEB822__" => {
                section = "deb822";
                continue;
            }
            "__YUM__" => {
                section = "yum";
                continue;
            }
            "__PM__" => {
                section = "pm";
                continue;
            }
            "__SUDO__" => {
                section = "sudo";
                continue;
            }
            _ => {}
        }
        match section {
            "osrelease" => {
                if let Some((key, value)) = line.split_once('=') {
                    let value = value.trim().trim_matches('"').to_string();
                    match key.trim() {
                        "ID" => status.distro_id = value,
                        "PRETTY_NAME" | "NAME" => {
                            if status.distro_name.is_empty() || key.trim() == "PRETTY_NAME" {
                                status.distro_name = value;
                            }
                        }
                        "VERSION_CODENAME" => status.codename = value,
                        "VERSION_ID" => status.version_id = value,
                        _ => {}
                    }
                }
            }
            "apt" => apt.push(line.to_string()),
            "deb822" => deb822.push(line.to_string()),
            "yum" => yum.push(line.to_string()),
            "pm" => {
                if status.package_manager.is_empty() && !line.trim().is_empty() {
                    status.package_manager = line.trim().to_string();
                }
            }
            "sudo" => {
                if line.trim() == "1" {
                    status.can_write = true;
                }
            }
            _ => {}
        }
    }

    status.family = distro_family(&status.distro_id, &status.package_manager).to_string();
    let mut current = Vec::new();
    current.extend(apt.iter().cloned());
    current.extend(deb822.iter().cloned());
    current.extend(yum.iter().cloned());
    status.current_sources = current.join("\n");
    status.detected_mirror = detect_mirror(&status.current_sources).to_string();
    status.is_mirror = !status.detected_mirror.is_empty();
    status.presets = mirror_presets(&status.distro_id, &status.family, &status.detected_mirror);
    if !status.can_write {
        status.can_write = detect_sudo_ok(output);
    }
    status
}

fn detect_sudo_ok(output: &str) -> bool {
    let mut seen = false;
    for line in output.lines() {
        if line.trim() == "__SUDO__" {
            seen = true;
        } else if seen && line.trim() == "1" {
            return true;
        }
    }
    false
}

pub fn distro_family(id: &str, pm: &str) -> &'static str {
    match id {
        "ubuntu" => "ubuntu",
        "debian" | "raspbian" | "linuxmint" => "debian",
        "centos" | "rhel" | "almalinux" | "rocky" | "ol" | "amzn" | "fedora" => "rhel",
        _ => match pm {
            "apt-get" => "debian",
            "dnf" | "yum" => "rhel",
            "apk" => "alpine",
            "zypper" => "suse",
            _ => "unknown",
        },
    }
}

pub const MIRROR_HOSTS: [&str; 5] = [
    "mirrors.aliyun.com",
    "mirrors.cloud.tencent.com",
    "mirrors.tuna.tsinghua.edu.cn",
    "mirrors.ustc.edu.cn",
    "repo.huaweicloud.com",
];

pub fn detect_mirror(sources: &str) -> &'static str {
    for host in MIRROR_HOSTS {
        if sources.contains(host) {
            return host;
        }
    }
    ""
}

pub fn mirror_base_url(mirror_id: &str, family: &str, distro_id: &str) -> String {
    let host = match mirror_id {
        "tencent" => "mirrors.cloud.tencent.com",
        "tuna" => "mirrors.tuna.tsinghua.edu.cn",
        "ustc" => "mirrors.ustc.edu.cn",
        "huawei" => "repo.huaweicloud.com",
        _ => "mirrors.aliyun.com",
    };
    let path = match family {
        "ubuntu" => "ubuntu",
        "debian" => "debian",
        "rhel" => match distro_id {
            "fedora" => "fedora",
            "centos" => "centos",
            "almalinux" => "almalinux",
            "rocky" => "rockylinux",
            _ => "centos",
        },
        _ => "",
    };
    if path.is_empty() {
        format!("https://{host}/")
    } else {
        format!("https://{host}/{path}")
    }
}

pub fn mirror_presets(distro_id: &str, family: &str, active: &str) -> Vec<MirrorPreset> {
    [("aliyun", "阿里云"), ("tencent", "腾讯云"), ("tuna", "清华大学"), ("ustc", "中科大"), ("huawei", "华为云")]
        .iter()
        .map(|(id, name)| {
            let base = mirror_base_url(id, family, distro_id);
            let host = base
                .trim_start_matches("https://")
                .split('/')
                .next()
                .unwrap_or("")
                .to_string();
            MirrorPreset {
                id: id.to_string(),
                name: name.to_string(),
                base_url: base,
                active: !active.is_empty() && active == host,
            }
        })
        .collect()
}

pub fn mirror_apply_command(mirror_id: &str, status: &MirrorStatus) -> AppResult<String> {
    let base = mirror_base_url(mirror_id, &status.family, &status.distro_id);
    if base.is_empty() {
        return Err(AppError::new("UNSUPPORTED_DISTRO", "暂不支持该发行版的镜像切换"));
    }
    let ts = "$(date +%Y%m%d%H%M%S)";
    let body = match status.family.as_str() {
        "ubuntu" | "debian" => {
            let mut script = String::new();
            script.push_str(&format!("{SUDO_PREFIX}set -e; TS={ts}; "));
            // 备份
            script.push_str(
                "if [ -f /etc/apt/sources.list ]; then $SUDO cp -a /etc/apt/sources.list /etc/apt/sources.list.taurissh.$TS; ",
            );
            script.push_str(&format!(
                "$SUDO sed -i -E 's#https?://(archive|security|ports|old-releases)\\.ubuntu\\.com/ubuntu#{}#g; s#https?://(deb|security|ftp)\\.debian\\.org(/debian)?#{}#g; s#https?://[a-z0-9.-]+/ubuntu#{}#g; s#https?://[a-z0-9.-]+/debian#{}#g' /etc/apt/sources.list; fi; ",
                base, base, base, base
            ));
            // deb822 (.sources)
            script.push_str("for f in /etc/apt/sources.list.d/*.sources; do [ -e \"$f\" ] || continue; ");
            script.push_str(&format!("$SUDO cp -a \"$f\" \"$f.taurissh.$TS\"; $SUDO sed -i -E 's#https?://[a-z0-9.-]+/ubuntu#{}#g' \"$f\"; done; ", base));
            script.push_str("$SUDO apt-get update 2>&1 | tail -5; echo MIRROR_APPLIED");
            script
        }
        "rhel" => {
            let host = base.trim_start_matches("https://").split('/').next().unwrap_or("").to_string();
            let mut script = format!("{SUDO_PREFIX}set -e; TS={ts}; ");
            script.push_str("for f in /etc/yum.repos.d/*.repo; do [ -e \"$f\" ] || continue; ");
            script.push_str(&format!("$SUDO cp -a \"$f\" \"$f.taurissh.$TS\"; "));
            script.push_str(&format!(
                "$SUDO sed -i -E 's#^mirrorlist=#\\# mirrorlist disabled by TauriSSH: #; s#https?://(mirror|vault|dl|repo|download)[a-z0-9.-]*\\.(centos|fedoraproject|almalinux|rockylinux|oracle)[a-z.]*#https://{host}#g' \"$f\"; done; "
            ));
            script.push_str("if command -v dnf >/dev/null 2>&1; then $SUDO dnf makecache 2>&1 | tail -5; else $SUDO yum makecache 2>&1 | tail -5; fi; echo MIRROR_APPLIED");
            script
        }
        _ => return Err(AppError::new("UNSUPPORTED_DISTRO", "暂不支持该发行版的镜像切换")),
    };
    Ok(body)
}

// ============================ 时间同步 ============================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimeSyncStatus {
    pub now: String,
    pub timezone: String,
    pub ntp_synchronized: bool,
    pub service: String,
    pub service_active: bool,
    pub service_enabled: bool,
    pub chrony_installed: bool,
    pub ntpd_active: bool,
    pub servers: Vec<String>,
    pub tracking: Vec<(String, String)>,
    pub can_write: bool,
}

pub fn time_status_command() -> &'static str {
    r#"printf '__NOW__=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"; timedatectl 2>/dev/null; echo __SVC__; printf 'chronyd_active='; systemctl is-active chronyd 2>/dev/null; printf 'chrony_active='; systemctl is-active chrony 2>/dev/null; printf 'chronyd_enabled='; systemctl is-enabled chronyd 2>/dev/null; printf 'chrony_enabled='; systemctl is-enabled chrony 2>/dev/null; printf 'ntp_active='; systemctl is-active ntp 2>/dev/null; printf 'ntpd_active='; systemctl is-active ntpd 2>/dev/null; command -v chronyc >/dev/null 2>&1 && echo CHRONYCLI=1 || echo CHRONYCLI=0; echo __CONF__; grep -hE '^(pool|server|makestep)' /etc/chrony/chrony.conf /etc/chrony.conf 2>/dev/null; echo __TRACKING__; chronyc tracking 2>/dev/null; echo __SUDO__; { sudo -n true 2>/dev/null && echo 1 || echo 0; }"#
}

pub fn parse_time_status(output: &str) -> TimeSyncStatus {
    let mut status = TimeSyncStatus::default();
    let mut section = "head";
    for line in output.lines() {
        let trimmed = line.trim();
        match trimmed {
            "__SVC__" => {
                section = "svc";
                continue;
            }
            "__CONF__" => {
                section = "conf";
                continue;
            }
            "__TRACKING__" => {
                section = "tracking";
                continue;
            }
            "__SUDO__" => {
                section = "sudo";
                continue;
            }
            _ => {}
        }
        match section {
            "head" => {
                if let Some(v) = trimmed.strip_prefix("__NOW__=") {
                    status.now = v.to_string();
                } else if let Some(v) = trimmed.strip_prefix("Time zone:") {
                    status.timezone = v.trim().split_whitespace().next().unwrap_or("").to_string();
                } else if trimmed.contains("System clock synchronized:") {
                    status.ntp_synchronized = trimmed.ends_with("yes");
                }
            }
            "svc" => {
                if let Some((key, value)) = trimmed.split_once('=') {
                    let value = value.trim();
                    match key.trim() {
                        "CHRONYCLI" => status.chrony_installed = value == "1",
                        "chronyd_active" | "chrony_active" => {
                            if value == "active" {
                                status.service = if key.trim().starts_with("chronyd") {
                                    "chronyd".into()
                                } else {
                                    "chrony".into()
                                };
                                status.service_active = true;
                            }
                        }
                        "chronyd_enabled" | "chrony_enabled" => {
                            if value == "enabled" {
                                if status.service.is_empty() {
                                    status.service = if key.trim().starts_with("chronyd") {
                                        "chronyd".into()
                                    } else {
                                        "chrony".into()
                                    };
                                }
                                status.service_enabled = true;
                            }
                        }
                        "ntp_active" | "ntpd_active" => {
                            if value == "active" {
                                status.ntpd_active = true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            "conf" => {
                if trimmed.starts_with("pool ") || trimmed.starts_with("server ") {
                    if let Some(host) = trimmed.split_whitespace().nth(1) {
                        status.servers.push(host.to_string());
                    }
                }
            }
            "tracking" => {
                if let Some((k, v)) = trimmed.split_once(':') {
                    status.tracking.push((k.trim().to_string(), v.trim().to_string()));
                }
            }
            "sudo" => {
                if trimmed == "1" {
                    status.can_write = true;
                }
            }
            _ => {}
        }
    }
    // root 或免密 sudo 均可写
    if !status.can_write {
        status.can_write = detect_sudo_ok(output);
    }
    if status.service.is_empty() {
        status.service = "chronyd".into();
    }
    status
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSyncAction {
    pub action: String,
    #[serde(default)]
    pub servers: Vec<String>,
}

pub fn time_action_command(request: &TimeSyncAction) -> AppResult<String> {
    let svc = "if systemctl list-unit-files 2>/dev/null | grep -q '^chronyd'; then SVC=chronyd; else SVC=chrony; fi;";
    let body = match request.action.as_str() {
        "install" => format!(
            "{}if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update && $SUDO apt-get install -y chrony; elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y chrony; elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y chrony; else echo NO_PACKAGE_MANAGER; exit 1; fi", sudo_checked()
        ),
        "enable" => format!("{}{svc} $SUDO systemctl enable --now $SVC", sudo_checked()),
        "disable" => format!("{}{svc} $SUDO systemctl disable --now $SVC", sudo_checked()),
        "restart" => format!("{}{svc} $SUDO systemctl restart $SVC", sudo_checked()),
        "makestep" => format!("{}$SUDO chronyc makestep 2>&1 || chronyc makestep 2>&1 || true", sudo_checked()),
        "set-servers" => {
            let servers: Vec<String> = request
                .servers
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if servers.is_empty() {
                return Err(AppError::validation("NTP 服务器不能为空"));
            }
            for server in &servers {
                if !server
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
                {
                    return Err(AppError::validation("NTP 服务器地址不合法"));
                }
            }
            let pools: Vec<String> = servers.iter().map(|s| format!("pool {s} iburst")).collect();
            let quoted = shq(&pools.join("\n"));
            format!(
                "{}set -e; TS=$(date +%Y%m%d%H%M%S); CONF=/etc/chrony/chrony.conf; [ -f \"$CONF\" ] || CONF=/etc/chrony.conf; [ -f \"$CONF\" ] || {{ echo NO_CHRONY_CONF; exit 1; }}; $SUDO cp -a \"$CONF\" \"$CONF.taurissh.$TS\"; $SUDO sed -i -E '/^(pool|server) /d' \"$CONF\"; printf '%s\\n' {quoted} | $SUDO tee -a \"$CONF\" >/dev/null; {svc} $SUDO systemctl restart $SVC; echo SERVERS_UPDATED", sudo_checked()
            )
        }
        other => return Err(AppError::new("UNSUPPORTED_ACTION", format!("不支持的时间同步操作：{other}"))),
    };
    Ok(body)
}

// ============================ 时区 ============================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimezoneStatus {
    pub timezone: String,
    pub local_time: String,
    pub universal_time: String,
    pub rtc_in_local_tz: bool,
    pub ntp_synchronized: bool,
    pub zones: Vec<String>,
    pub can_write: bool,
    pub common_zones: Vec<String>,
}

pub fn timezone_status_command() -> &'static str {
    r#"timedatectl 2>/dev/null; echo __ZONES__; timedatectl list-timezones 2>/dev/null; echo __SUDO__; { sudo -n true 2>/dev/null && echo 1 || echo 0; }"#
}

pub fn parse_timezone_status(output: &str) -> TimezoneStatus {
    let mut status = TimezoneStatus::default();
    let mut section = "head";
    for line in output.lines() {
        let trimmed = line.trim();
        match trimmed {
            "__ZONES__" => {
                section = "zones";
                continue;
            }
            "__SUDO__" => {
                section = "sudo";
                continue;
            }
            _ => {}
        }
        match section {
            "head" => {
                if let Some(v) = trimmed.strip_prefix("Time zone:") {
                    status.timezone = v.trim().split_whitespace().next().unwrap_or("").to_string();
                } else if let Some(v) = trimmed.strip_prefix("Local time:") {
                    status.local_time = v.trim().to_string();
                } else if let Some(v) = trimmed.strip_prefix("Universal time:") {
                    status.universal_time = v.trim().to_string();
                } else if trimmed.contains("RTC in local TZ:") {
                    status.rtc_in_local_tz = trimmed.ends_with("yes");
                } else if trimmed.contains("System clock synchronized:") {
                    status.ntp_synchronized = trimmed.ends_with("yes");
                }
            }
            "zones" => {
                // UTC 等合法时区不含斜杠，同样需要收录
                if !trimmed.is_empty()
                    && trimmed.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
                {
                    status.zones.push(trimmed.to_string());
                }
            }
            "sudo" => {
                if trimmed == "1" {
                    status.can_write = true;
                }
            }
            _ => {}
        }
    }
    if !status.can_write {
        status.can_write = detect_sudo_ok(output);
    }
    status.common_zones = [
        "Asia/Shanghai",
        "Asia/Hong_Kong",
        "Asia/Singapore",
        "Asia/Tokyo",
        "Asia/Seoul",
        "UTC",
        "Europe/London",
        "Europe/Berlin",
        "America/New_York",
        "America/Los_Angeles",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    status
}

pub fn valid_timezone(zone: &str) -> bool {
    if zone.is_empty() || zone.len() > 64 {
        return false;
    }
    zone.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
}

pub fn timezone_set_command(zone: &str) -> AppResult<String> {
    if !valid_timezone(zone) {
        return Err(AppError::validation("时区名称不合法"));
    }
    Ok(format!(
        "{}timedatectl set-timezone {} 2>&1; timedatectl 2>/dev/null", sudo_checked(),
        shq(zone)
    ))
}

// ============================ systemd 开机启动项 ============================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub unit: String,
    pub state: String,
    pub enabled: bool,
    pub active: bool,
    pub description: String,
    pub is_target: bool,
}

pub fn services_command() -> &'static str {
    r#"systemctl list-unit-files --type=service --no-pager --no-legend 2>/dev/null; echo __UNITS__; systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | head -400; echo __SUDO__; { sudo -n true 2>/dev/null && echo 1 || echo 0; }"#
}

pub fn parse_services(output: &str) -> Vec<ServiceInfo> {
    let mut map: Vec<ServiceInfo> = Vec::new();
    let mut section = "files";
    let mut descriptions: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut active_map: std::collections::HashMap<String, bool> = std::collections::HashMap::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed == "__UNITS__" {
            section = "units";
            continue;
        }
        if trimmed == "__SUDO__" {
            break;
        }
        if trimmed.is_empty() {
            continue;
        }
        match section {
            "files" => {
                let mut parts = trimmed.split_whitespace();
                let Some(unit) = parts.next() else { continue };
                if !unit.ends_with(".service") {
                    continue;
                }
                let state = parts.next().unwrap_or("").to_string();
                map.push(ServiceInfo {
                    unit: unit.to_string(),
                    enabled: state == "enabled" || state == "enabled-runtime",
                    state,
                    active: false,
                    description: String::new(),
                    is_target: false,
                });
            }
            "units" => {
                // 列：UNIT LOAD ACTIVE SUB DESCRIPTION...（部分版本会在开头加 ● 标记）
                let clean = trimmed.trim_start_matches(['●', '*']).trim_start();
                let mut parts = clean.split_whitespace();
                let Some(unit) = parts.next() else { continue };
                let _load = parts.next();
                let active = parts.next().unwrap_or("");
                active_map.insert(unit.to_string(), active == "active");
                let rest: Vec<&str> = clean.split_whitespace().skip(4).collect();
                if !rest.is_empty() {
                    descriptions.insert(unit.to_string(), rest.join(" "));
                }
            }
            _ => {}
        }
    }

    for service in map.iter_mut() {
        service.active = active_map.get(&service.unit).copied().unwrap_or(false);
        if let Some(desc) = descriptions.get(&service.unit) {
            service.description = desc.clone();
        }
    }
    map
}

pub fn service_action_command(unit: &str, action: &str) -> AppResult<String> {
    if !unit.ends_with(".service")
        || !unit
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':'))
    {
        return Err(AppError::validation("服务名称不合法"));
    }
    let verb = match action {
        "enable" => "enable",
        "disable" => "disable",
        "start" => "start",
        "stop" => "stop",
        "restart" => "restart",
        "mask" => "mask",
        "unmask" => "unmask",
        other => return Err(AppError::new("UNSUPPORTED_ACTION", format!("不支持的服务操作：{other}"))),
    };
    Ok(format!(
        "{}systemctl {verb} {} 2>&1; systemctl is-enabled {} 2>&1; systemctl is-active {} 2>&1", sudo_checked(),
        shq(unit),
        shq(unit),
        shq(unit)
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCreateRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub working_directory: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub enable: bool,
    #[serde(default)]
    pub start: bool,
}

pub fn valid_custom_service_name(name: &str) -> bool {
    let name = name.trim().trim_end_matches(".service");
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false)
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn sanitize_unit_description(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "TauriSSH custom service".into()
    } else {
        trimmed.chars().take(256).collect()
    }
}

fn valid_service_user(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn unit_quote(value: &str) -> String {
    if value.chars().any(|c| c.is_whitespace() || c == '"' || c == '\\') {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// 通过 UI 创建自定义 systemd 服务，并可选设置开机启动 / 立即启动。
pub fn service_create_command(request: &ServiceCreateRequest) -> AppResult<String> {
    let name = request.name.trim().trim_end_matches(".service").to_string();
    if !valid_custom_service_name(&name) {
        return Err(AppError::validation(
            "服务名称只能包含字母、数字、-、_、.，且必须以字母或数字开头",
        ));
    }
    let command = request.command.trim();
    if command.is_empty() {
        return Err(AppError::validation("启动命令不能为空"));
    }
    if command.len() > 8192 || command.contains('\0') {
        return Err(AppError::validation("启动命令过长或包含非法字符"));
    }
    let workdir = request.working_directory.trim();
    if !workdir.is_empty() && (!workdir.starts_with('/') || workdir.len() > 1024 || workdir.contains('\n')) {
        return Err(AppError::validation("工作目录必须是绝对路径"));
    }
    let user = request.user.trim();
    if !user.is_empty() && !valid_service_user(user) {
        return Err(AppError::validation("运行用户名称不合法"));
    }
    let description = sanitize_unit_description(&request.description);
    let unit = format!("{name}.service");
    let unit_path = format!("/etc/systemd/system/{unit}");
    let script_path = format!("/etc/taurissh/services/{name}.sh");
    let mut unit_lines = vec![
        "[Unit]".to_string(),
        format!("Description={}", unit_quote(&description)),
        "After=network.target".to_string(),
        "[Service]".to_string(),
        "Type=simple".to_string(),
    ];
    if !user.is_empty() {
        unit_lines.push(format!("User={user}"));
    }
    if !workdir.is_empty() {
        unit_lines.push(format!("WorkingDirectory={}", unit_quote(workdir)));
    }
    unit_lines.push(format!("ExecStart=/bin/sh {script_path}"));
    unit_lines.push("[Install]".to_string());
    unit_lines.push("WantedBy=multi-user.target".to_string());

    let mut body = format!(
        "{}set -e; NAME={}; UNIT={}; SCRIPT={}; if [ -e \"$UNIT\" ]; then echo SERVICE_EXISTS; exit 1; fi; $SUDO mkdir -p /etc/taurissh/services; printf '%s\\n' '#!/bin/sh' {} | $SUDO tee \"$SCRIPT\" >/dev/null; $SUDO chmod 0755 \"$SCRIPT\"; printf '%s\\n'",
        sudo_checked(),
        shq(&name),
        shq(&unit_path),
        shq(&script_path),
        shq(command)
    );
    for line in &unit_lines {
        body.push(' ');
        body.push_str(&shq(line));
    }
    body.push_str(" | $SUDO tee \"$UNIT\" >/dev/null; $SUDO chmod 0644 \"$UNIT\"; $SUDO systemctl daemon-reload; ");
    if request.enable {
        body.push_str("$SUDO systemctl enable \"$NAME.service\" 2>&1; ");
    }
    if request.start {
        body.push_str("$SUDO systemctl start \"$NAME.service\" 2>&1; ");
    }
    body.push_str("echo SERVICE_CREATED; systemctl is-enabled \"$NAME.service\" 2>&1; systemctl is-active \"$NAME.service\" 2>&1");
    Ok(body)
}

// ============================ 进程 / 性能 ============================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub rss: u64,
    pub state: String,
    pub name: String,
    pub command: String,
}

pub fn process_list_command() -> &'static str {
    "ps -eo pid,ppid,user,pcpu,pmem,rss,stat,comm,args --sort=-pcpu --no-headers 2>/dev/null | head -250"
}

pub fn parse_processes(output: &str) -> Vec<ProcessInfo> {
    let mut list = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let (Some(pid), Some(ppid), Some(user), Some(cpu), Some(mem), Some(rss), Some(state), Some(name)) = (
            parts.next().and_then(|v| v.parse::<u32>().ok()),
            parts.next().and_then(|v| v.parse::<u32>().ok()),
            parts.next(),
            parts.next().and_then(|v| v.parse::<f64>().ok()),
            parts.next().and_then(|v| v.parse::<f64>().ok()),
            parts.next().and_then(|v| v.parse::<u64>().ok()),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        let command: Vec<&str> = parts.collect();
        list.push(ProcessInfo {
            pid,
            ppid,
            user: user.to_string(),
            cpu,
            mem,
            rss: rss * 1024,
            state: state.to_string(),
            name: name.to_string(),
            command: command.join(" "),
        });
    }
    list
}

pub fn kill_process_command(pid: u32, signal: &str) -> AppResult<String> {
    if pid == 0 {
        return Err(AppError::validation("无效的进程号"));
    }
    let sig = match signal {
        "" | "TERM" => "TERM",
        "KILL" => "KILL",
        "HUP" => "HUP",
        "INT" => "INT",
        "STOP" => "STOP",
        "CONT" => "CONT",
        other => return Err(AppError::validation(format!("不支持的信號：{other}"))),
    };
    Ok(format!(
        "{}kill -{sig} {pid} 2>&1; rc=$?; echo KILL_SENT; exit $rc",
        sudo_checked()
    ))
}

/// 性能快照：两次 /proc/stat 采样 + 内存 / 磁盘 / 网络。
pub fn performance_command() -> &'static str {
    r#"LC_ALL=C; export LC_ALL; awk '/^cpu/{print}' /proc/stat; echo __SLEEP__; sleep 0.6; awk '/^cpu/{print}' /proc/stat; echo __MEM__; free -b 2>/dev/null; echo __DISK__; df -PB1 / 2>/dev/null | tail -1; echo __NET__; awk 'NR>2{rx+=$2;tx+=$10} END{print rx,tx}' /proc/net/dev; echo __UP__; awk '{print int($1)}' /proc/uptime; echo __LOAD__; awk '{print $1,$2,$3}' /proc/loadavg; echo __UNAME__; uname -sr; printf 'hostname='; hostname; echo __CPUINFO__; awk -F: '/^model name/{gsub(/^[ \t]+/,"",$2); print $2; exit}' /proc/cpuinfo"#
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoreUsage {
    pub name: String,
    pub usage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSnapshot {
    pub cpu: f64,
    pub cores: Vec<CoreUsage>,
    pub memory_percent: f64,
    pub memory_used: u64,
    pub memory_total: u64,
    pub memory_available: u64,
    pub memory_cached: u64,
    pub swap_percent: f64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disk_percent: f64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub disk_available: u64,
    pub network_rx: u64,
    pub network_tx: u64,
    pub uptime: u64,
    pub load: String,
    pub kernel: String,
    pub hostname: String,
    pub cpu_model: String,
    pub process_count: u64,
}

pub fn parse_performance(output: &str, process_count: u64) -> PerformanceSnapshot {
    let mut snapshot = PerformanceSnapshot {
        cpu_model: String::new(),
        ..Default::default()
    };
    let mut first: std::collections::HashMap<String, (f64, f64)> = std::collections::HashMap::new();
    let mut second: std::collections::HashMap<String, (f64, f64)> = std::collections::HashMap::new();
    let mut section = "first";

    for line in output.lines() {
        let trimmed = line.trim();
        match trimmed {
            "__SLEEP__" => {
                section = "second";
                continue;
            }
            "__MEM__" => {
                section = "mem";
                continue;
            }
            "__DISK__" => {
                section = "disk";
                continue;
            }
            "__NET__" => {
                section = "net";
                continue;
            }
            "__UP__" => {
                section = "up";
                continue;
            }
            "__LOAD__" => {
                section = "load";
                continue;
            }
            "__UNAME__" => {
                section = "uname";
                continue;
            }
            "__CPUINFO__" => {
                section = "cpuinfo";
                continue;
            }
            _ => {}
        }
        match section {
            "first" | "second" => {
                if let Some(rest) = trimmed.strip_prefix("cpu") {
                    // "cpu" 后紧跟空白表示总体使用率，否则是 "cpuN"
                    let aggregate = rest.starts_with(|c: char| c.is_whitespace());
                    let mut parts = rest.split_whitespace();
                    let name = if aggregate {
                        String::new()
                    } else {
                        parts.next().unwrap_or("").to_string()
                    };
                    let values: Vec<f64> = parts.filter_map(|v| v.parse::<f64>().ok()).collect();
                    if values.len() >= 4 {
                        let idle = values[3] + values.get(4).copied().unwrap_or(0.0);
                        let total: f64 = values.iter().take(8).sum();
                        if section == "first" {
                            first.insert(name, (idle, total));
                        } else {
                            second.insert(name, (idle, total));
                        }
                    }
                }
            }
            "mem" => {
                let raw: Vec<&str> = trimmed.split_whitespace().collect();
                let parse = |idx: usize| raw.get(idx).and_then(|v| v.parse::<u64>().ok());
                match raw.first().copied() {
                    Some("Mem:") if raw.len() >= 7 => {
                        if let (Some(total), Some(used), Some(shared), Some(buff), Some(available)) =
                            (parse(1), parse(2), parse(4), parse(5), parse(6))
                        {
                            snapshot.memory_total = total;
                            snapshot.memory_used = used;
                            snapshot.memory_available = available;
                            snapshot.memory_cached = buff + shared;
                            snapshot.memory_percent = if total > 0 {
                                (used as f64) * 100.0 / (total as f64)
                            } else {
                                0.0
                            };
                        }
                    }
                    Some("Swap:") if raw.len() >= 3 => {
                        if let (Some(total), Some(used)) = (parse(1), parse(2)) {
                            snapshot.swap_total = total;
                            snapshot.swap_used = used;
                            snapshot.swap_percent = if total > 0 {
                                (used as f64) * 100.0 / (total as f64)
                            } else {
                                0.0
                            };
                        }
                    }
                    _ => {}
                }
            }
            "disk" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 5 {
                    if let Ok(total) = parts[1].parse::<u64>() {
                        snapshot.disk_total = total;
                        snapshot.disk_used = parts[2].parse::<u64>().unwrap_or(0);
                        snapshot.disk_available = parts[3].parse::<u64>().unwrap_or(0);
                        snapshot.disk_percent = parts[4]
                            .trim_end_matches('%')
                            .parse::<f64>()
                            .unwrap_or_else(|_| {
                                if total > 0 {
                                    (snapshot.disk_used as f64) * 100.0 / (total as f64)
                                } else {
                                    0.0
                                }
                            });
                    }
                }
            }
            "net" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 2 {
                    snapshot.network_rx = parts[0].parse().unwrap_or(0);
                    snapshot.network_tx = parts[1].parse().unwrap_or(0);
                }
            }
            "up" => snapshot.uptime = trimmed.parse().unwrap_or(0),
            "load" => snapshot.load = trimmed.to_string(),
            "uname" => {
                if !trimmed.starts_with("hostname=") {
                    snapshot.kernel = trimmed.to_string();
                }
            }
            "cpuinfo" => {
                if !trimmed.is_empty() {
                    snapshot.cpu_model = trimmed.to_string();
                }
            }
            _ => {}
        }
        if let Some(rest) = trimmed.strip_prefix("hostname=") {
            snapshot.hostname = rest.trim().to_string();
        }
    }

    for (name, (idle1, total1)) in first.iter() {
        if let Some((idle2, total2)) = second.get(name) {
            let dt = total2 - total1;
            let di = idle2 - idle1;
            let usage = if dt > 0.0 { 100.0 * (1.0 - di / dt) } else { 0.0 };
            let usage = usage.clamp(0.0, 100.0);
            if name.is_empty() {
                snapshot.cpu = (usage * 10.0).round() / 10.0;
            } else {
                snapshot.cores.push(CoreUsage {
                    name: format!("CPU {name}"),
                    usage: (usage * 10.0).round() / 10.0,
                });
            }
        }
    }
    snapshot.cores.sort_by_key(|core| {
        core.name
            .trim_start_matches("CPU ")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    snapshot.process_count = process_count;
    snapshot
}

// ============================ 测试 ============================

#[cfg(test)]
mod tests {
    use super::*;

    const UFW_SAMPLE: &str = "__BACKEND__=ufw\nStatus: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere\n80,443/tcp                 ALLOW IN    Anywhere\n22/tcp (v6)                ALLOW IN    Anywhere (v6)\n\n__SUDO__\n1";

    #[test]
    fn parses_ufw_status() {
        let status = parse_firewall(UFW_SAMPLE);
        assert_eq!(status.backend, "ufw");
        assert!(status.active);
        assert_eq!(status.default_incoming, "deny");
        assert_eq!(status.default_outgoing, "allow");
        assert_eq!(status.default_routed, "disabled");
        assert_eq!(status.rules.len(), 3);
        assert_eq!(status.rules[0].to, "22/tcp");
        assert_eq!(status.rules[0].action, "ALLOW IN");
        assert_eq!(status.rules[2].from, "Anywhere");
        assert!(status.rules[2].v6);
        assert!(status.can_write);
    }

    const FIREWALLD_SAMPLE: &str = "__BACKEND__=firewalld\nrunning\n__ZONE__\npublic\n__LIST__\npublic (active)\n  target: default\n  services: dhcpv6-client ssh\n  ports: 8080/tcp\n";

    const UFW_INACTIVE_SAMPLE: &str = "__BACKEND__=ufw\nStatus: inactive\n__ADDED__\nAdded user rules (see 'ufw status' for running firewall):\nufw allow 10296/tcp\nufw deny 8080/tcp\nufw limit 22/tcp\n__SUDO__\n1";

    #[test]
    fn parses_ufw_added_rules_when_inactive() {
        let status = parse_firewall(UFW_INACTIVE_SAMPLE);
        assert!(!status.active);
        assert_eq!(status.rules.len(), 3);
        assert_eq!(status.rules[0].to, "10296/tcp");
        assert_eq!(status.rules[0].action, "ALLOW IN");
        assert_eq!(status.rules[1].action, "DENY IN");
        assert_eq!(status.rules[2].action, "LIMIT IN");
    }

    #[test]
    fn parses_firewalld_status() {
        let status = parse_firewall(FIREWALLD_SAMPLE);
        assert_eq!(status.backend, "firewalld");
        assert!(status.active);
        assert_eq!(status.zone, "public");
        assert_eq!(status.services, vec!["dhcpv6-client", "ssh"]);
        assert_eq!(status.ports, vec!["8080/tcp"]);
    }

    #[test]
    fn validates_firewall_specs() {
        assert!(valid_spec("22/tcp"));
        assert!(valid_spec("80,443/tcp"));
        assert!(valid_spec("ssh"));
        assert!(!valid_spec("22; rm -rf /"));
        assert!(!valid_spec(""));
    }

    #[test]
    fn builds_firewall_commands() {
        let cmd = firewall_action_command(&FirewallAction {
            action: "allow".into(),
            spec: "22/tcp".into(),
            policy: String::new(),
            backend: "ufw".into(),
            rule_action: String::new(),
        })
        .unwrap();
        assert!(cmd.contains("ufw allow '22/tcp'"));
        assert!(cmd.starts_with("SUDO=''"));

        let delete = firewall_action_command(&FirewallAction {
            action: "delete".into(),
            spec: "22/tcp".into(),
            policy: String::new(),
            backend: "ufw".into(),
            rule_action: "ALLOW IN".into(),
        })
        .unwrap();
        assert!(delete.contains("ufw --force delete allow '22/tcp'"));

        assert!(firewall_action_command(&FirewallAction {
            action: "allow".into(),
            spec: "22; rm".into(),
            policy: String::new(),
            backend: "ufw".into(),
            rule_action: String::new(),
        })
        .is_err());

        assert!(firewall_action_command(&FirewallAction {
            action: "deny".into(),
            spec: "80/tcp".into(),
            policy: String::new(),
            backend: "firewalld".into(),
            rule_action: String::new(),
        })
        .is_err());
    }

    const OS_RELEASE: &str = "NAME=\"Ubuntu\"\nVERSION_ID=\"22.04\"\nPRETTY_NAME=\"Ubuntu 22.04.5 LTS\"\nID=ubuntu\nVERSION_CODENAME=jammy\n__APT__\ndeb http://archive.ubuntu.com/ubuntu/ jammy main restricted\ndeb http://security.ubuntu.com/ubuntu/ jammy-security main\n__DEB822__\n__YUM__\n__PM__\napt-get\n__SUDO__\n1";

    #[test]
    fn parses_mirror_status() {
        let status = parse_mirror_status(OS_RELEASE);
        assert_eq!(status.distro_id, "ubuntu");
        assert_eq!(status.codename, "jammy");
        assert_eq!(status.family, "ubuntu");
        assert_eq!(status.package_manager, "apt-get");
        assert!(!status.is_mirror);
        assert_eq!(status.presets.len(), 5);
        let aliyun = status.presets.iter().find(|p| p.id == "aliyun").unwrap();
        assert_eq!(aliyun.base_url, "https://mirrors.aliyun.com/ubuntu");
    }

    #[test]
    fn detects_existing_mirror() {
        let output = OS_RELEASE.replace("archive.ubuntu.com", "mirrors.aliyun.com");
        let status = parse_mirror_status(&output);
        assert_eq!(status.detected_mirror, "mirrors.aliyun.com");
        assert!(status.is_mirror);
    }

    #[test]
    fn builds_mirror_script() {
        let status = parse_mirror_status(OS_RELEASE);
        let script = mirror_apply_command("tuna", &status).unwrap();
        assert!(script.contains("mirrors.tuna.tsinghua.edu.cn/ubuntu"));
        assert!(script.contains("sources.list.taurissh"));
        assert!(script.contains("TS=$(date +%Y%m%d%H%M%S)"));
        assert!(script.contains("apt-get update"));
    }

    const TIME_SAMPLE: &str = "__NOW__=2026-10-27 16:00:00 CST\n               Local time: Mon 2026-10-27 16:00:00 CST\n           Universal time: Mon 2026-10-27 08:00:00 UTC\n                RTC time: Mon 2026-10-27 08:00:00\n               Time zone: Asia/Shanghai (CST, +0800)\nSystem clock synchronized: yes\n              NTP service: active\n__SVC__\nchronyd_active=active\nchrony_active=inactive\nchronyd_enabled=enabled\nchrony_enabled=disabled\nntp_active=inactive\nntpd_active=inactive\nCHRONYCLI=1\n__CONF__\npool ntp.aliyun.com iburst\n__TRACKING__\nReference ID    : A1B2C3D4 (ntp.aliyun.com)\nStratum         : 2\n__SUDO__\n1";

    #[test]
    fn parses_time_sync_status() {
        let status = parse_time_status(TIME_SAMPLE);
        assert_eq!(status.timezone, "Asia/Shanghai");
        assert!(status.ntp_synchronized);
        assert!(status.service_active);
        assert!(status.service_enabled);
        assert!(status.chrony_installed);
        assert!(!status.ntpd_active);
        assert_eq!(status.service, "chronyd");
        assert_eq!(status.servers, vec!["ntp.aliyun.com"]);
        assert!(!status.tracking.is_empty());
    }

    #[test]
    fn builds_time_commands() {
        let cmd = time_action_command(&TimeSyncAction {
            action: "set-servers".into(),
            servers: vec!["ntp.aliyun.com".into(), "time.tencent.com".into()],
        })
        .unwrap();
        assert!(cmd.contains("pool ntp.aliyun.com iburst"));
        assert!(cmd.contains(".taurissh.$TS"), "命令应包含备份后缀: {cmd}");
        assert!(cmd.contains("TS=$(date +%Y%m%d%H%M%S)"));
        assert!(cmd.contains("NO_CHRONY_CONF"));

        assert!(time_action_command(&TimeSyncAction {
            action: "set-servers".into(),
            servers: vec!["bad;rm".into()],
        })
        .is_err());
    }

    const TZ_SAMPLE: &str = "               Local time: Mon 2026-10-27 16:00:00 CST\n           Universal time: Mon 2026-10-27 08:00:00 UTC\n               Time zone: Asia/Shanghai (CST, +0800)\nRTC in local TZ: no\nSystem clock synchronized: yes\n__ZONES__\nAsia/Shanghai\nAsia/Tokyo\nUTC\n__SUDO__\n1";

    #[test]
    fn parses_timezone() {
        let status = parse_timezone_status(TZ_SAMPLE);
        assert_eq!(status.timezone, "Asia/Shanghai");
        assert_eq!(status.zones.len(), 3);
        assert!(!status.rtc_in_local_tz);
        assert!(status.can_write);
    }

    #[test]
    fn validates_timezone_names() {
        assert!(valid_timezone("Asia/Shanghai"));
        assert!(valid_timezone("UTC"));
        assert!(!valid_timezone("Asia/Shanghai; rm -rf /"));
    }

    const SERVICES_SAMPLE: &str = "ssh.service enabled enabled\ncron.service enabled enabled\nnginx.service disabled disabled\n__UNITS__\nssh.service loaded active running OpenBSD Secure Shell server\ncron.service loaded active running Regular background program processing daemon\n
__SUDO__\n1";

    #[test]
    fn parses_services() {
        let list = parse_services(SERVICES_SAMPLE);
        assert_eq!(list.len(), 3);
        let ssh = list.iter().find(|s| s.unit == "ssh.service").unwrap();
        assert!(ssh.enabled);
        assert!(ssh.active);
        assert!(ssh.description.contains("OpenBSD"));
        let nginx = list.iter().find(|s| s.unit == "nginx.service").unwrap();
        assert!(!nginx.enabled);
        assert!(!nginx.active);
    }

    #[test]
    fn rejects_bad_service_names() {
        assert!(service_action_command("ssh.service", "restart").is_ok());
        assert!(service_action_command("ssh.service; rm -rf /", "restart").is_err());
        assert!(service_action_command("ssh.service", "explode").is_err());
    }

    #[test]
    fn builds_custom_service_command() {
        let command = service_create_command(&ServiceCreateRequest {
            name: "taurissh-demo.service".into(),
            description: "TauriSSH demo".into(),
            command: "/bin/echo hello".into(),
            working_directory: "/opt/demo".into(),
            user: "root".into(),
            enable: true,
            start: true,
        })
        .unwrap();
        assert!(command.contains("/etc/systemd/system/taurissh-demo.service"));
        assert!(command.contains("ExecStart=/bin/sh /etc/taurissh/services/taurissh-demo.sh"));
        assert!(command.contains("systemctl enable"));
        assert!(command.contains("systemctl start"));
        assert!(command.contains("systemctl daemon-reload"));

        assert!(service_create_command(&ServiceCreateRequest {
            name: "../bad".into(),
            description: String::new(),
            command: "/bin/echo bad".into(),
            working_directory: String::new(),
            user: String::new(),
            enable: true,
            start: false,
        })
        .is_err());
    }

    const PS_SAMPLE: &str = "    1     0 root        0.0  0.1  12345 Ss   systemd /sbin/init splash\n  123   456 www-data    2.5  1.2  98765 S    nginx nginx: worker process\n";

    #[test]
    fn parses_processes() {
        let list = parse_processes(PS_SAMPLE);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].pid, 1);
        assert_eq!(list[0].user, "root");
        assert_eq!(list[0].rss, 12_345 * 1024);
        assert_eq!(list[1].cpu, 2.5);
        assert!(list[1].command.starts_with("nginx"));
    }

    #[test]
    fn validates_kill_signals() {
        assert!(kill_process_command(1234, "TERM").is_ok());
        assert!(kill_process_command(1234, "").is_ok());
        assert!(kill_process_command(0, "TERM").is_err());
        assert!(kill_process_command(1234, "EXPLODE").is_err());
    }

    const PERF_SAMPLE: &str = "cpu  100 0 50 800 10 0 0 0 0 0\ncpu0 50 0 25 400 5 0 0 0 0 0\ncpu1 50 0 25 400 5 0 0 0 0 0\n__SLEEP__\ncpu  200 0 100 1600 20 0 0 0 0 0\ncpu0 100 0 50 800 10 0 0 0 0 0\ncpu1 100 0 50 800 10 0 0 0 0 0\n__MEM__\n              total        used        free      shared  buff/cache   available\nMem:     8000000000  4000000000  2000000000   100000000  1900000000  3000000000\nSwap:    2000000000  1000000000  1000000000\n__DISK__\n/dev/vda1 100000000 60000000 40000000 60% /\n__NET__\n12345 67890\n__UP__\n86400\n__LOAD__\n0.10 0.20 0.30\n__UNAME__\nLinux 5.15.0\nhostname=test-host\n__CPUINFO__\nIntel(R) Xeon(R) Platinum 8275CL CPU @ 3.00GHz";

    #[test]
    fn parses_performance_snapshot() {
        let snapshot = parse_performance(PERF_SAMPLE, 210);
        // 两次采样间隔内 active 仅增加 150，total 增加 960，因此忙时占比约 15.6%。
        assert!((snapshot.cpu - 15.6).abs() < 0.5, "cpu={}", snapshot.cpu);
        assert_eq!(snapshot.cores.len(), 2);
        assert_eq!(snapshot.memory_total, 8_000_000_000);
        assert_eq!(snapshot.memory_available, 3_000_000_000);
        assert_eq!(snapshot.memory_cached, 2_000_000_000);
        assert!((snapshot.memory_percent - 50.0).abs() < 0.1);
        assert_eq!(snapshot.swap_used, 1_000_000_000);
        assert_eq!(snapshot.disk_percent, 60.0);
        assert_eq!(snapshot.network_rx, 12345);
        assert_eq!(snapshot.network_tx, 67890);
        assert_eq!(snapshot.uptime, 86400);
        assert_eq!(snapshot.hostname, "test-host");
        assert_eq!(snapshot.process_count, 210);
        assert!(snapshot.cpu_model.contains("Xeon"));
    }
}
