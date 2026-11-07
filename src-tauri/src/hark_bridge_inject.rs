//! 把文件桥连接消息发进某个 Hark 账号的聊天/项目。
//!
//! 占位实现：真正的实现由另一个分支（wip/bridge-inject）提供，合并时以那边为准，
//! 保持下面的函数签名不变即可。文件桥后台（crate::hark_bridge）在桥就绪或地址变化时调用它。

/// 把 `text`（「【连接文件桥】…」消息，含密钥，不要记日志）发给 `profile_id` 这个 Hark 账号；
/// `project_url` 非空时发到该项目，否则发到当前聊天；`marker_url` 是文件桥地址，
/// 可用来判断页面里是否已经发过同一地址。
pub async fn send_connect_message(
    _app: &tauri::AppHandle,
    _profile_id: &str,
    _project_url: &str,
    _text: &str,
    _marker_url: &str,
) -> Result<(), String> {
    Err("未实现".to_string())
}
