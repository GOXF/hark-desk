//! 文件桥的 Tauri 命令（注册在 lib.rs 的 invoke_handler 里）。
//! 前端调用时参数用 camelCase（Tauri 会映射到这里的 snake_case 参数名）。
//! 修改类命令都返回最新的完整状态；状态变化同时通过 "hark-bridge://state" 事件推送。

use super::logic::{self, MAIN_ID, MODE_CUSTOM};
use super::settings::{Binding, BridgeConf};
use super::types::{BridgePatch, HarkBridgeState};
use super::manager;

/// 当前完整状态（不含任何密钥明文）。
#[tauri::command]
pub async fn hark_bridge_state() -> Result<HarkBridgeState, String> {
    Ok(manager()?.state())
}

/// 保存通道设置并重启主桥。
/// - mode：ngrok / custom / cloudflare
/// - ngrokDomain：传了就更新（空串 = 清除）
/// - ngrokToken：非空才更新；clearToken=true 清除
/// - customUrl：传了就更新；mode=custom 时必须有值
/// - useProxy：主桥是否走全局代理
#[tauri::command]
pub async fn hark_bridge_tunnel_save(
    mode: String,
    ngrok_domain: Option<String>,
    ngrok_token: Option<String>,
    clear_token: Option<bool>,
    custom_url: Option<String>,
    use_proxy: Option<bool>,
) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    let mode = mode.trim().to_ascii_lowercase();
    if !logic::valid_mode(&mode) {
        return Err("通道模式只能是 ngrok / custom / cloudflare".to_string());
    }
    mgr.with_settings(|s| {
        let custom = match &custom_url {
            Some(u) => logic::clean_base_url(u),
            None => s.tunnel.custom_url.clone(),
        };
        if mode == MODE_CUSTOM && custom.is_empty() {
            return Err("先填你自己的地址，例如 https://bridge.example.com".to_string());
        }
        if mode == MODE_CUSTOM {
            if let Some(b) = s
                .bridges
                .iter()
                .find(|b| !b.is_main() && !b.public_url.is_empty() && b.public_url == custom)
            {
                return Err(format!("「{}」已经在用这个地址了，换一个", b.name));
            }
        }
        s.tunnel.custom_url = custom;
        s.tunnel.mode = mode.clone();
        if let Some(d) = &ngrok_domain {
            s.tunnel.ngrok_domain = logic::clean_domain(d);
        }
        if let Some(t) = &ngrok_token {
            let t = t.trim();
            if !t.is_empty() {
                s.tunnel.ngrok_token = t.to_string();
            }
        }
        if clear_token.unwrap_or(false) {
            s.tunnel.ngrok_token.clear();
        }
        if let Some(p) = use_proxy {
            s.tunnel.use_proxy = p;
        }
        Ok(())
    })?;
    if mgr.main_should_run() {
        let _ = mgr.start(MAIN_ID);
    }
    mgr.emit_state();
    Ok(mgr.state())
}

/// 新建一条子桥并启动。id 由名字生成（小写英文/数字/-/_，会出现在 /mcp/<id> 里），
/// 名字是中文等生成不了时用 bridge、bridge2…。新桥排在 bridges 最后。
#[tauri::command]
pub async fn hark_bridge_create(name: String, folder: String) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("请选择共享文件夹".to_string());
    }
    let name = name.trim().to_string();
    let id = mgr.with_settings(|s| {
        let mut base = logic::safe_id(&name);
        if !logic::valid_id(&base) {
            base = "bridge".to_string();
        }
        base.truncate(28);
        let mut id = base.clone();
        let mut n = 2u32;
        while id == MAIN_ID || s.bridge(&id).is_some() {
            id = format!("{base}{n}");
            n += 1;
        }
        let mut conf = BridgeConf::new_main();
        conf.id = id.clone();
        conf.name = if name.is_empty() { id.clone() } else { name.clone() };
        conf.folder = folder.clone();
        s.bridges.push(conf);
        Ok(id)
    })?;
    if let Err(error) = mgr.start(&id) {
        tracing::warn!(bridge = %id, %error, "新文件桥启动失败");
    }
    mgr.emit_state();
    Ok(mgr.state())
}

/// 修改一条桥。改共享文件夹 / 只读 / 允许删除 / 自己的地址 / 端口会重启这条桥；
/// 改执行模式不重启（直接通知运行中的桥）。
#[tauri::command]
pub async fn hark_bridge_update(id: String, patch: BridgePatch) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    let restart = mgr.with_settings(|s| {
        let tunnel_custom = if s.tunnel.mode == MODE_CUSTOM {
            s.tunnel.custom_url.clone()
        } else {
            String::new()
        };
        let mode_custom = s.tunnel.mode == MODE_CUSTOM;
        let others: Vec<(String, String, String)> = s
            .bridges
            .iter()
            .filter(|b| b.id != id)
            .map(|b| (b.id.clone(), b.name.clone(), b.public_url.clone()))
            .collect();
        let Some(b) = s.bridge_mut(&id) else {
            return Err(format!("找不到文件桥「{id}」"));
        };
        let mut restart = false;
        if let Some(n) = &patch.name {
            let n = n.trim();
            if !n.is_empty() {
                b.name = n.to_string();
            }
        }
        if let Some(f) = &patch.folder {
            let f = f.trim();
            if f.is_empty() {
                return Err("共享文件夹不能为空".to_string());
            }
            if f != b.folder {
                b.folder = f.to_string();
                restart = true;
            }
        }
        if let Some(v) = patch.readonly {
            if v != b.readonly {
                b.readonly = v;
                restart = true;
            }
        }
        if let Some(v) = patch.allow_delete {
            if v != b.allow_delete {
                b.allow_delete = v;
                restart = true;
            }
        }
        if let Some(u) = &patch.public_url {
            let u = logic::clean_base_url(u);
            if b.is_main() {
                if !u.is_empty() {
                    return Err("主文件桥的地址在「通道」设置里改".to_string());
                }
            } else {
                if !u.is_empty() && u == tunnel_custom {
                    return Err(format!(
                        "这个地址已经是主通道了，换一个，或者留空走 主地址/mcp/{}",
                        b.id
                    ));
                }
                if let Some((_, other_name, _)) =
                    others.iter().find(|(_, _, pu)| !u.is_empty() && *pu == u)
                {
                    return Err(format!("「{other_name}」已经在用这个地址"));
                }
                if u != b.public_url {
                    b.public_url = u;
                    restart = true;
                }
            }
        }
        if let Some(p) = patch.port {
            if p != b.port {
                b.port = p;
                // 主桥只在「自己的域名」模式下用这个端口
                restart = restart || !b.is_main() || mode_custom;
            }
        }
        Ok(restart)
    })?;
    if let Some(m) = &patch.exec_mode {
        if let Err(error) = mgr.set_exec_mode(&id, m).await {
            tracing::warn!(bridge = %id, %error, "通知文件桥切换执行模式失败");
        }
    }
    if restart && mgr.should_run(&id) {
        if let Err(error) = mgr.start(&id) {
            tracing::warn!(bridge = %id, %error, "文件桥重启失败");
        }
    }
    mgr.emit_state();
    mgr.autosend_check();
    Ok(mgr.state())
}

/// 删除一条子桥（主桥不能删）。只删连接，不删文件夹里的文件；用它的账号改回默认桥。
#[tauri::command]
pub async fn hark_bridge_delete(id: String) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    mgr.delete(&id)?;
    Ok(mgr.state())
}

/// 启动（或重启）一条桥，并清掉「用户已停止」标记。
#[tauri::command]
pub async fn hark_bridge_start(id: String) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    mgr.start_by_user(&id)?;
    Ok(mgr.state())
}

/// 停止一条桥，并记住「用户已停止」（下次启动应用不自动启动）。
#[tauri::command]
pub async fn hark_bridge_stop(id: String) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    mgr.stop(&id)?;
    Ok(mgr.state())
}

/// 设置默认桥（没绑定的账号手动发送时用它）。
#[tauri::command]
pub async fn hark_bridge_set_default(id: String) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    mgr.with_settings(|s| {
        if s.bridge(&id).is_none() {
            return Err(format!("找不到文件桥「{id}」"));
        }
        s.default_bridge = id.clone();
        Ok(())
    })?;
    mgr.emit_state();
    Ok(mgr.state())
}

/// 绑定账号：profileId 用 bridgeId 这条桥，连接消息发到 projectUrl（空 = 当前聊天）。
/// 绑定后如果桥已在线且还没发过这个地址，会立即自动发送。
#[tauri::command]
pub async fn hark_bridge_bind(
    profile_id: String,
    bridge_id: String,
    project_url: String,
) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Err("缺少账号 profileId".to_string());
    }
    let project_url = project_url.trim().to_string();
    mgr.with_settings(|s| {
        if s.bridge(&bridge_id).is_none() {
            return Err(format!("找不到文件桥「{bridge_id}」"));
        }
        s.bindings.retain(|b| b.profile_id != profile_id);
        s.bindings.push(Binding {
            profile_id: profile_id.clone(),
            bridge_id: bridge_id.clone(),
            project_url: project_url.clone(),
        });
        Ok(())
    })?;
    mgr.forget_failure(&profile_id);
    mgr.emit_state();
    mgr.autosend_check();
    Ok(mgr.state())
}

/// 解除账号绑定（同时忘掉已发送记录）。
#[tauri::command]
pub async fn hark_bridge_unbind(profile_id: String) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    mgr.with_settings(|s| {
        s.bindings.retain(|b| b.profile_id != profile_id);
        s.sent.retain(|r| r.profile_id != profile_id);
        Ok(())
    })?;
    mgr.forget_failure(&profile_id);
    mgr.emit_state();
    Ok(mgr.state())
}

/// 某条桥的连接消息（与 Hark Hub 一致，含密钥——只用于发给 Hark 或复制，不要记日志）。
#[tauri::command]
pub async fn hark_bridge_connect_message(bridge_id: String) -> Result<String, String> {
    manager()?.connect_message(&bridge_id)
}

/// 立即把连接消息发给这个账号（调用 hark_bridge_inject::send_connect_message）。
/// 账号没绑定时用默认桥、发到当前聊天。
#[tauri::command]
pub async fn hark_bridge_send(profile_id: String) -> Result<(), String> {
    manager()?.send_now(&profile_id).await
}

/// 回复命令执行审批。answer：allow / always / deny / never。
#[tauri::command]
pub async fn hark_bridge_confirm(
    bridge_id: String,
    req_id: String,
    answer: String,
) -> Result<HarkBridgeState, String> {
    let mgr = manager()?;
    mgr.answer_confirm(&bridge_id, &req_id, &answer).await?;
    Ok(mgr.state())
}

/// 某条桥最近的日志（已打码：不含密钥和 authtoken）。
#[tauri::command]
pub async fn hark_bridge_logs(id: String) -> Result<Vec<String>, String> {
    Ok(manager()?.logs(&id))
}
