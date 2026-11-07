//! 文件桥里与平台无关的纯逻辑（移植自 hark-hub-go 的 internal/bridge/bridge.go）：
//! 解析 HarkBridge 的 stdout 协议、拼「发给 Hark」的连接消息、整理地址、生成路由表等。
//! 这里不碰进程、文件和锁，方便单元测试。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use base64::Engine;
use regex::Regex;
use serde::Deserialize;

/// 主文件桥的固定 id。
pub const MAIN_ID: &str = "main";
/// 「自己的域名」模式下主桥默认监听的本机端口（用户的服务器反代到这里）。
pub const DEFAULT_CUSTOM_PORT: u16 = 17890;

/// 通道模式：三种都要保留。
pub const MODE_NGROK: &str = "ngrok";
pub const MODE_CUSTOM: &str = "custom";
pub const MODE_CLOUDFLARE: &str = "cloudflare";

pub fn valid_mode(mode: &str) -> bool {
    matches!(mode, MODE_NGROK | MODE_CUSTOM | MODE_CLOUDFLARE)
}

// ---------- HarkBridge stdout 协议 ----------

/// HarkBridge 输出的一行解析结果（协议见 bridge-go/main.go printConnectionInfo / exec.go approve）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineEvent {
    /// 普通日志
    None,
    /// HARK_BRIDGE_URL=<地址，可能为空>
    Url(String),
    /// HARK_BRIDGE_PORT=<端口>
    Port(u16),
    /// HARK_BRIDGE_FIXED=0/1
    Fixed(bool),
    /// TUNNEL=ngrok / cloudflare-fallback
    Tunnel(String),
    /// HARK_BRIDGE_TOKEN=<密钥>
    Token(String),
    /// HARK_BRIDGE_FOLDER=<共享文件夹>
    Folder(String),
    /// HARK_BRIDGE_CONFIRM=<请求id> <base64 JSON>
    Confirm { req_id: String, payload_b64: String },
    /// HARK_BRIDGE_ERROR=<错误>
    Error(String),
}

/// 解析一行（调用方已去掉行尾 \r\n）。
pub fn parse_line(line: &str) -> LineEvent {
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_URL=") {
        return LineEvent::Url(v.trim().to_string());
    }
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_PORT=") {
        let v = v.trim();
        if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(n) = v.parse::<u16>() {
                return LineEvent::Port(n);
            }
        }
        return LineEvent::None;
    }
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_FIXED=") {
        let v = v.trim();
        if v.len() == 1 && v.as_bytes()[0].is_ascii_digit() {
            return LineEvent::Fixed(v == "1");
        }
        return LineEvent::None;
    }
    if let Some(v) = line.strip_prefix("TUNNEL=") {
        return LineEvent::Tunnel(v.trim().to_string());
    }
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_TOKEN=") {
        return LineEvent::Token(v.trim().to_string());
    }
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_FOLDER=") {
        return LineEvent::Folder(v.trim().to_string());
    }
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_CONFIRM=") {
        if let Some((id, b64)) = v.split_once(' ') {
            let (id, b64) = (id.trim(), b64.trim());
            if !id.is_empty() && !b64.is_empty() && !b64.contains(' ') {
                return LineEvent::Confirm {
                    req_id: id.to_string(),
                    payload_b64: b64.to_string(),
                };
            }
        }
        return LineEvent::None;
    }
    if let Some(v) = line.strip_prefix("HARK_BRIDGE_ERROR=") {
        return LineEvent::Error(v.to_string());
    }
    LineEvent::None
}

/// 执行命令前的权限询问内容（HARK_BRIDGE_CONFIRM 里 base64 的 JSON）。
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct ConfirmPayload {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub cwd: String,
}

/// 解开权限询问；解不开返回空结构。
pub fn decode_confirm(b64: &str) -> ConfirmPayload {
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ConfirmPayload>(&bytes).ok())
        .unwrap_or_default()
}

fn bridge_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"hark_[0-9a-fA-F]{16,}").expect("密钥正则"))
}

/// 要记进日志的一行：密钥行整行丢掉（返回 None）；行内出现的文件桥密钥（hark_…）
/// 和 ngrok authtoken 一律打码。HarkBridge 在「连接信息」块里会明文打印密钥，
/// 这时还不知道密钥是什么，所以按格式打码。
pub fn redact_line(line: &str, secrets: &[&str]) -> Option<String> {
    if line.starts_with("HARK_BRIDGE_TOKEN=") {
        return None;
    }
    let mut out = bridge_token_re().replace_all(line, "hark_***").into_owned();
    for s in secrets {
        let s = s.trim();
        if s.len() >= 4 && out.contains(s) {
            out = out.replace(s, "***");
        }
    }
    Some(out)
}

// ---------- 地址 / 消息 ----------

/// 在 Hark 里登记的 MCP 名称。
pub fn mcp_name(id: &str) -> String {
    if id == MAIN_ID {
        "hark-files".to_string()
    } else {
        format!("hark-files-{id}")
    }
}

/// 主桥地址去掉末尾 /mcp。
pub fn main_base(main_url: &str) -> &str {
    main_url.strip_suffix("/mcp").unwrap_or(main_url)
}

/// 经主桥转发的子桥对外地址：主桥地址根/mcp/<id>。主桥地址为空或子桥没在运行返回空串。
pub fn routed_url(id: &str, main_url: &str, sub_running: bool) -> String {
    if main_url.is_empty() {
        return String::new();
    }
    if id == MAIN_ID {
        return main_url.to_string();
    }
    if !sub_running {
        return String::new();
    }
    format!("{}/mcp/{}", main_base(main_url), id)
}

/// 「发给 Hark」的连接消息（与 Hark Hub 的 bridge.Message 逐字一致）。url 为空返回空串。
pub fn connect_message(id: &str, name: &str, url: &str, fixed: bool, token: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let name = if name.is_empty() { id } else { name };
    let kind = if fixed {
        "固定地址，重启不变"
    } else {
        "临时地址，重启会变"
    };
    format!(
        "【连接文件桥】请把我电脑上的 Hark 本地文件桥连上：MCP 名称 {}，地址 {}，传输 streamable_http（文件桥「{}」，{}）。密钥：{}（用这个密钥存进保险库再登记，不要回显密钥；已有同名服务器就先删掉再加）。连好后回我一句\"已连接\"。",
        mcp_name(id),
        url,
        name,
        kind,
        token
    )
}

fn scheme_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^https?://").expect("scheme 正则"))
}

fn mcp_tail_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)/mcp$").expect("mcp 正则"))
}

/// 整理用户填的 ngrok 固定域名：去掉 https://、末尾斜杠和 /mcp。
pub fn clean_domain(d: &str) -> String {
    let d = d.trim();
    let d = scheme_re().replace(d, "");
    let d = d.trim_end_matches('/');
    let d = mcp_tail_re().replace(d, "");
    d.trim_end_matches('/').to_string()
}

/// 用户自己的地址 → 根地址：补 https://，去掉结尾的 / 和 /mcp。
pub fn clean_base_url(u: &str) -> String {
    let u = u.trim();
    if u.is_empty() {
        return String::new();
    }
    let mut s = if scheme_re().is_match(u) {
        u.to_string()
    } else {
        format!("https://{u}")
    };
    s = s.trim_end_matches('/').to_string();
    if let Some(stripped) = s.strip_suffix("/mcp") {
        s = stripped.to_string();
    }
    s.trim_end_matches('/').to_string()
}

/// 设置里的执行命令模式 → 规范值（off / confirm / auto）。兼容 Hub 的 "ask"。
pub fn normalize_exec_mode(m: &str) -> String {
    match m.trim().to_ascii_lowercase().as_str() {
        "auto" => "auto".to_string(),
        "confirm" | "ask" => "confirm".to_string(),
        _ => "off".to_string(),
    }
}

fn safe_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^a-z0-9_-]").expect("id 正则"))
}

fn valid_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,31}$").expect("id 校验正则"))
}

/// 桥名规范化（小写、只留 a-z0-9_-）。
pub fn safe_id(s: &str) -> String {
    safe_re()
        .replace_all(&s.trim().to_lowercase(), "")
        .into_owned()
}

/// 子桥 id 是否可用（会出现在 /mcp/<id> 地址里；不能是 main）。
pub fn valid_id(id: &str) -> bool {
    valid_id_re().is_match(id) && id != MAIN_ID
}

/// 子桥路由表 {"桥名": 端口}，按键排序输出（与 Hub 的 RoutesJSON 相同）。
pub fn routes_json(m: &BTreeMap<String, u16>) -> String {
    serde_json::to_string(m).unwrap_or_else(|_| "{}".to_string())
}

/// 崩溃自动重启的退避秒数：2、4、8 … 最多 60。
pub fn backoff_secs(attempt: u32) -> u64 {
    let shift = attempt.clamp(1, 6);
    (1u64 << shift).min(60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol_lines() {
        assert_eq!(
            parse_line("HARK_BRIDGE_URL=https://a.trycloudflare.com/mcp"),
            LineEvent::Url("https://a.trycloudflare.com/mcp".into())
        );
        assert_eq!(parse_line("HARK_BRIDGE_URL="), LineEvent::Url(String::new()));
        assert_eq!(parse_line("HARK_BRIDGE_PORT=17890"), LineEvent::Port(17890));
        assert_eq!(parse_line("HARK_BRIDGE_PORT=x"), LineEvent::None);
        assert_eq!(parse_line("HARK_BRIDGE_FIXED=1"), LineEvent::Fixed(true));
        assert_eq!(parse_line("HARK_BRIDGE_FIXED=0"), LineEvent::Fixed(false));
        assert_eq!(
            parse_line("TUNNEL=cloudflare-fallback"),
            LineEvent::Tunnel("cloudflare-fallback".into())
        );
        assert_eq!(
            parse_line("HARK_BRIDGE_CONFIRM=ab12 eyJ9"),
            LineEvent::Confirm {
                req_id: "ab12".into(),
                payload_b64: "eyJ9".into()
            }
        );
        assert_eq!(
            parse_line("HARK_BRIDGE_ERROR=坏了"),
            LineEvent::Error("坏了".into())
        );
        assert_eq!(parse_line("普通日志"), LineEvent::None);
    }

    #[test]
    fn redacts_tokens() {
        assert_eq!(redact_line("HARK_BRIDGE_TOKEN=hark_abc", &[]), None);
        let tok = format!("hark_{}", "a1".repeat(24));
        assert_eq!(
            redact_line(&format!("   {tok}"), &[]).unwrap(),
            "   hark_***"
        );
        assert_eq!(
            redact_line("authtoken 2abcdEFG done", &["2abcdEFG"]).unwrap(),
            "authtoken *** done"
        );
    }

    #[test]
    fn message_matches_hub() {
        let m = connect_message("main", "主文件桥", "https://x.ngrok-free.dev/mcp", true, "hark_t");
        assert_eq!(
            m,
            "【连接文件桥】请把我电脑上的 Hark 本地文件桥连上：MCP 名称 hark-files，地址 https://x.ngrok-free.dev/mcp，传输 streamable_http（文件桥「主文件桥」，固定地址，重启不变）。密钥：hark_t（用这个密钥存进保险库再登记，不要回显密钥；已有同名服务器就先删掉再加）。连好后回我一句\"已连接\"。"
        );
        assert_eq!(connect_message("a", "", "", false, "t"), "");
        assert!(connect_message("docs", "", "u", false, "t").contains("MCP 名称 hark-files-docs"));
        assert!(connect_message("docs", "", "u", false, "t").contains("文件桥「docs」，临时地址，重启会变"));
    }

    #[test]
    fn cleans_addresses() {
        assert_eq!(clean_domain(" https://x.ngrok-free.dev/MCP/ "), "x.ngrok-free.dev");
        assert_eq!(clean_base_url("bridge.example.com/mcp/"), "https://bridge.example.com");
        assert_eq!(clean_base_url("http://h:8080/"), "http://h:8080");
        assert_eq!(clean_base_url("  "), "");
        assert_eq!(
            routed_url("docs", "https://a.b/mcp", true),
            "https://a.b/mcp/docs"
        );
        assert_eq!(routed_url("docs", "https://a.b/mcp", false), "");
    }

    #[test]
    fn ids_and_routes() {
        assert_eq!(safe_id(" My Docs! "), "mydocs");
        assert!(valid_id("docs-1"));
        assert!(!valid_id("main"));
        assert!(!valid_id(""));
        let mut m = BTreeMap::new();
        m.insert("b".to_string(), 2u16);
        m.insert("a".to_string(), 1u16);
        assert_eq!(routes_json(&m), r#"{"a":1,"b":2}"#);
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(10), 60);
    }
}
