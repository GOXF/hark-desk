//! 文件桥设置：持久化在 app data 目录的 hark-bridge.json。
//!
//! 内存里（[`Settings`]）是明文；落盘时 ngrok 固定域名和 authtoken 经 [`super::secret`] 加密。
//! 文件桥自己的密钥（hark_…）不在这里，它由 HarkBridge 写在各自的 HARK_BRIDGE_HOME 里。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::logic::{self, MAIN_ID, MODE_CLOUDFLARE};
use super::secret;

pub const SETTINGS_FILE: &str = "hark-bridge.json";

fn default_mode() -> String {
    MODE_CLOUDFLARE.to_string()
}

fn default_true() -> bool {
    true
}

fn default_exec_mode() -> String {
    "off".to_string()
}

fn default_main_id() -> String {
    MAIN_ID.to_string()
}

/// 通道设置（明文，仅在内存里）。
#[derive(Debug, Clone)]
pub struct TunnelConf {
    /// ngrok / custom / cloudflare
    pub mode: String,
    /// ngrok 固定域名（已整理，不带 https:// 和 /mcp）
    pub ngrok_domain: String,
    /// ngrok authtoken（明文，绝不打印）
    pub ngrok_token: String,
    /// 「自己的域名」模式的根地址（已整理，不带 /mcp）
    pub custom_url: String,
    /// 主桥是否走全局代理（把当前进程的 HTTPS_PROXY 传给主桥）
    pub use_proxy: bool,
}

impl Default for TunnelConf {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            ngrok_domain: String::new(),
            ngrok_token: String::new(),
            custom_url: String::new(),
            use_proxy: true,
        }
    }
}

/// 一条文件桥的设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConf {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub readonly: bool,
    #[serde(default)]
    pub allow_delete: bool,
    /// off / confirm / auto
    #[serde(default = "default_exec_mode")]
    pub exec_mode: String,
    /// 子桥自己的地址（根地址，不带 /mcp）；非空时这条桥 TUNNEL=none，用自己的地址。主桥忽略。
    #[serde(default)]
    pub public_url: String,
    /// 本机端口。子桥：首次启动时分配并记住；主桥：只在「自己的域名」模式下使用（0 = 17890）。
    #[serde(default)]
    pub port: u16,
    /// 用户手动停止了这条桥（启动应用时不自动启动它）。
    #[serde(default)]
    pub stopped: bool,
}

impl BridgeConf {
    pub fn new_main() -> Self {
        Self {
            id: MAIN_ID.to_string(),
            name: "主文件桥".to_string(),
            folder: String::new(),
            readonly: false,
            allow_delete: false,
            exec_mode: default_exec_mode(),
            public_url: String::new(),
            port: 0,
            stopped: false,
        }
    }

    pub fn is_main(&self) -> bool {
        self.id == MAIN_ID
    }
}

/// 账号绑定：某个 Hark 账号（浏览器 profile）用哪条桥，连接消息发到哪个项目。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub profile_id: String,
    pub bridge_id: String,
    #[serde(default)]
    pub project_url: String,
}

/// 已经成功发给某个账号的地址（同一地址只自动发一次）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SentRecord {
    pub profile_id: String,
    pub url: String,
    #[serde(default)]
    pub project_url: String,
}

/// 内存里的完整设置。
#[derive(Debug, Clone)]
pub struct Settings {
    pub tunnel: TunnelConf,
    pub bridges: Vec<BridgeConf>,
    pub default_bridge: String,
    pub bindings: Vec<Binding>,
    pub sent: Vec<SentRecord>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            tunnel: TunnelConf::default(),
            bridges: vec![BridgeConf::new_main()],
            default_bridge: default_main_id(),
            bindings: Vec::new(),
            sent: Vec::new(),
        }
    }
}

// ---------- 落盘格式 ----------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTunnel {
    #[serde(default = "default_mode")]
    mode: String,
    /// 加密后的 ngrok 固定域名
    #[serde(default)]
    ngrok_domain: String,
    /// 加密后的 ngrok authtoken
    #[serde(default)]
    ngrok_token: String,
    #[serde(default)]
    custom_url: String,
    #[serde(default = "default_true")]
    use_proxy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    #[serde(default = "stored_version")]
    version: u32,
    #[serde(default)]
    tunnel: Option<StoredTunnel>,
    #[serde(default)]
    bridges: Vec<BridgeConf>,
    #[serde(default = "default_main_id")]
    default_bridge: String,
    #[serde(default)]
    bindings: Vec<Binding>,
    #[serde(default)]
    sent: Vec<SentRecord>,
}

fn stored_version() -> u32 {
    1
}

impl Settings {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(SETTINGS_FILE)
    }

    /// 读设置；文件不存在或损坏时用默认值（损坏的文件改名为 .bad 保留）。
    pub fn load(data_dir: &Path) -> Settings {
        let path = Self::path(data_dir);
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => return Settings::default(),
        };
        let stored: StoredFile = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(error) => {
                tracing::warn!(%error, "hark-bridge.json 无法解析，改用默认设置");
                let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                return Settings::default();
            }
        };
        let st = stored.tunnel.unwrap_or_else(|| StoredTunnel {
            mode: default_mode(),
            use_proxy: true,
            ..StoredTunnel::default()
        });
        let ngrok_domain = secret::decrypt(&st.ngrok_domain).unwrap_or_else(|error| {
            tracing::warn!(%error, "ngrok 固定域名解密失败，按未设置处理");
            String::new()
        });
        let ngrok_token = secret::decrypt(&st.ngrok_token).unwrap_or_else(|error| {
            tracing::warn!(%error, "ngrok authtoken 解密失败，按未设置处理");
            String::new()
        });
        let mut s = Settings {
            tunnel: TunnelConf {
                mode: st.mode,
                ngrok_domain: logic::clean_domain(&ngrok_domain),
                ngrok_token: ngrok_token.trim().to_string(),
                custom_url: logic::clean_base_url(&st.custom_url),
                use_proxy: st.use_proxy,
            },
            bridges: stored.bridges,
            default_bridge: stored.default_bridge,
            bindings: stored.bindings,
            sent: stored.sent,
        };
        s.normalize();
        s
    }

    /// 修正不合法的值：主桥必有且排第一、id 去重、模式合法、默认桥存在、绑定指向存在的桥。
    pub fn normalize(&mut self) {
        if !logic::valid_mode(&self.tunnel.mode) {
            self.tunnel.mode = default_mode();
        }
        let mut seen = std::collections::HashSet::new();
        self.bridges
            .retain(|b| (b.id == MAIN_ID || logic::valid_id(&b.id)) && seen.insert(b.id.clone()));
        match self.bridges.iter().position(|b| b.id == MAIN_ID) {
            Some(0) => {}
            Some(i) => {
                let main = self.bridges.remove(i);
                self.bridges.insert(0, main);
            }
            None => self.bridges.insert(0, BridgeConf::new_main()),
        }
        for b in &mut self.bridges {
            b.exec_mode = logic::normalize_exec_mode(&b.exec_mode);
            b.public_url = if b.is_main() {
                String::new()
            } else {
                logic::clean_base_url(&b.public_url)
            };
            if b.name.trim().is_empty() {
                b.name = if b.is_main() {
                    "主文件桥".to_string()
                } else {
                    b.id.clone()
                };
            }
        }
        if self.bridge(&self.default_bridge).is_none() {
            self.default_bridge = default_main_id();
        }
        let default_bridge = self.default_bridge.clone();
        let ids: std::collections::HashSet<String> =
            self.bridges.iter().map(|b| b.id.clone()).collect();
        for binding in &mut self.bindings {
            if !ids.contains(&binding.bridge_id) {
                binding.bridge_id = default_bridge.clone();
            }
        }
        let mut seen_profiles = std::collections::HashSet::new();
        self.bindings
            .retain(|b| !b.profile_id.is_empty() && seen_profiles.insert(b.profile_id.clone()));
        let mut seen_sent = std::collections::HashSet::new();
        self.sent
            .retain(|r| !r.profile_id.is_empty() && seen_sent.insert(r.profile_id.clone()));
    }

    /// 写盘（先写临时文件再改名，避免写一半）。
    pub fn save(&self, data_dir: &Path) -> Result<(), String> {
        let stored = StoredFile {
            version: stored_version(),
            tunnel: Some(StoredTunnel {
                mode: self.tunnel.mode.clone(),
                ngrok_domain: secret::encrypt(&self.tunnel.ngrok_domain),
                ngrok_token: secret::encrypt(&self.tunnel.ngrok_token),
                custom_url: self.tunnel.custom_url.clone(),
                use_proxy: self.tunnel.use_proxy,
            }),
            bridges: self.bridges.clone(),
            default_bridge: self.default_bridge.clone(),
            bindings: self.bindings.clone(),
            sent: self.sent.clone(),
        };
        let json = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(data_dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
        let path = Self::path(data_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("写入文件桥设置失败：{e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("保存文件桥设置失败：{e}"))?;
        Ok(())
    }

    pub fn bridge(&self, id: &str) -> Option<&BridgeConf> {
        self.bridges.iter().find(|b| b.id == id)
    }

    pub fn bridge_mut(&mut self, id: &str) -> Option<&mut BridgeConf> {
        self.bridges.iter_mut().find(|b| b.id == id)
    }

    pub fn binding(&self, profile_id: &str) -> Option<&Binding> {
        self.bindings.iter().find(|b| b.profile_id == profile_id)
    }

    pub fn sent_for(&self, profile_id: &str) -> Option<&SentRecord> {
        self.sent.iter().find(|r| r.profile_id == profile_id)
    }

    pub fn set_sent(&mut self, record: SentRecord) {
        self.sent.retain(|r| r.profile_id != record.profile_id);
        self.sent.push(record);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_main_first_and_fixes_refs() {
        let mut s = Settings {
            tunnel: TunnelConf {
                mode: "bogus".into(),
                ..TunnelConf::default()
            },
            bridges: vec![BridgeConf {
                id: "docs".into(),
                name: String::new(),
                folder: "C:/d".into(),
                readonly: false,
                allow_delete: false,
                exec_mode: "ask".into(),
                public_url: "x.example.com/mcp".into(),
                port: 0,
                stopped: false,
            }],
            default_bridge: "gone".into(),
            bindings: vec![Binding {
                profile_id: "p1".into(),
                bridge_id: "gone".into(),
                project_url: String::new(),
            }],
            sent: vec![],
        };
        s.normalize();
        assert_eq!(s.tunnel.mode, "cloudflare");
        assert_eq!(s.bridges[0].id, "main");
        assert_eq!(s.bridges[1].exec_mode, "confirm");
        assert_eq!(s.bridges[1].public_url, "https://x.example.com");
        assert_eq!(s.bridges[1].name, "docs");
        assert_eq!(s.default_bridge, "main");
        assert_eq!(s.bindings[0].bridge_id, "main");
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.tunnel.mode = "ngrok".into();
        s.tunnel.ngrok_token = "tok123456".into();
        s.tunnel.ngrok_domain = "x.ngrok-free.dev".into();
        s.save(dir.path()).unwrap();
        let raw = std::fs::read_to_string(Settings::path(dir.path())).unwrap();
        assert!(!raw.contains("\"tok123456\""));
        let back = Settings::load(dir.path());
        assert_eq!(back.tunnel.mode, "ngrok");
        assert_eq!(back.tunnel.ngrok_token, "tok123456");
        assert_eq!(back.tunnel.ngrok_domain, "x.ngrok-free.dev");
    }
}
