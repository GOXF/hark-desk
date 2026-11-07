//! 传给前端的状态结构（camelCase）。与 frontend/src/features/hark-bridge/types.ts 一一对应，
//! 契约见 hark-bridge-contract.md。绝不包含文件桥密钥和 ngrok authtoken 明文。

use serde::{Deserialize, Serialize};

/// 通道（主桥）状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    /// "ngrok" | "custom" | "cloudflare"
    pub mode: String,
    pub ngrok_domain: String,
    pub has_ngrok_token: bool,
    pub custom_url: String,
    pub use_proxy: bool,
    /// 主桥状态："stopped" | "starting" | "running" | "no-tunnel" | "error"
    pub status: String,
    /// 主桥对外地址（以 /mcp 结尾；没上线为空串）
    pub url: String,
    pub fixed: bool,
    pub port: u16,
    pub err: String,
    /// HarkBridge 实际用的通道："ngrok" | "cloudflare-fallback" | "custom" | ""
    pub tunnel: String,
}

/// 一条文件桥的状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub readonly: bool,
    pub allow_delete: bool,
    /// "off" | "confirm" | "auto"
    pub exec_mode: String,
    pub public_url: String,
    pub status: String,
    /// 地址可用且密钥已知（可以发连接消息）
    pub online: bool,
    pub url: String,
    pub port: u16,
    pub err: String,
    pub is_main: bool,
    /// 用户手动停止了（启动应用时不自动启动）
    pub stopped: bool,
    pub fixed: bool,
}

/// 账号绑定及发送情况。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingState {
    pub profile_id: String,
    pub bridge_id: String,
    pub project_url: String,
    /// 上次成功发送给这个账号的地址
    pub sent_url: Option<String>,
    pub sending: bool,
    /// 最近一次发送失败的原因
    pub send_err: Option<String>,
}

/// 等待用户审批的命令执行请求。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmState {
    pub bridge_id: String,
    pub req_id: String,
    pub kind: String,
    pub command: String,
    pub cwd: String,
}

/// hark_bridge_state 的返回值，也是 "hark-bridge://state" 事件的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarkBridgeState {
    pub tunnel: TunnelState,
    pub bridges: Vec<BridgeState>,
    pub default_bridge: String,
    pub bindings: Vec<BindingState>,
    pub confirms: Vec<ConfirmState>,
    /// 安装包里是否找到了 HarkBridge 程序
    pub bridge_exe_found: bool,
}

/// hark_bridge_update 的 patch（字段都可选，只改传了的）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgePatch {
    pub name: Option<String>,
    pub folder: Option<String>,
    pub readonly: Option<bool>,
    pub allow_delete: Option<bool>,
    pub exec_mode: Option<String>,
    /// 子桥自己的地址；传空串清除（改回经主桥转发）
    pub public_url: Option<String>,
    /// 本机端口（子桥；或「自己的域名」模式下的主桥）。0 = 自动
    pub port: Option<u16>,
}
