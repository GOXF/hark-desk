//! Hark 账号嵌入标签页（方案 B）。
//!
//! 账号的 hark.com WebView 直接作为主窗口（label `main`）的 wry 原生子视图，盖在
//! 前端 DOM 上方；前端 dockview 面板（HarkEmbedPanel）用占位 div 的
//! `getBoundingClientRect()` 告诉后端放在哪里（主窗口逻辑像素 = CSS px，原点是
//! 主窗口 webview 内容区左上角）。
//!
//! - 每个账号在主窗口最多一个嵌入视图，key = 账号 id；
//! - 视图用 [`hark_window::build_account_view_in`] 建，和 A 方案（独立窗口）同一套
//!   keeps_in_app / 代理 / 注入，数据目录同为 `hark-profiles/<id>`，登录态共用；
//!   Windows 上 WebContext 按同一目录新建、跟视图一起存放（和文件桥后台 WebView
//!   的做法一样），不借 A 窗口的 `SURFACES.contexts`，两边各自关闭互不影响；
//! - WebView 不是 Send，全部放在主线程 thread_local [`EMBEDS`] 里，所有操作经
//!   `run_on_main_thread`；`can_serve` 这类主线程外的查询读 [`opened_mirror`]。
//! - 页面不注册 Tauri IPC；Windows 的验证点击处理器与 A 方案共用，Agent / 插件都碰不到它。

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::Deserialize;
use tauri::Manager;
use tauri_runtime_wry::wry::{
    self, Rect, WebView,
    dpi::{LogicalPosition, LogicalSize},
};

use crate::hark_window;

/// 嵌入视图挂在哪个窗口上。
pub const EMBED_HOST_LABEL: &str = "main";

/// 前端传来的区域（主窗口逻辑像素）。
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct EmbedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl EmbedRect {
    /// 宽高 >= 1 且四个值都是有限数才算合法；不合法时视图隐藏。
    fn to_rect(self) -> Option<Rect> {
        let finite = [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite());
        if !finite || self.width < 1.0 || self.height < 1.0 {
            return None;
        }
        Some(Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        })
    }
}

struct EmbedView {
    view: WebView,
    #[cfg(target_os = "windows")]
    _context: wry::WebContext,
}

thread_local! {
    static EMBEDS: RefCell<HashMap<String, EmbedView>> = RefCell::new(HashMap::new());
}

/// 主线程外读「哪些账号开着嵌入视图」用的镜像。
fn opened_mirror() -> &'static Mutex<HashSet<String>> {
    static M: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashSet::new()))
}

fn sync_mirror(store: &HashMap<String, EmbedView>) {
    if let Ok(mut m) = opened_mirror().lock() {
        *m = store.keys().cloned().collect();
    }
}

/// 把 `f` 放到主线程上跑，异步等结果（不阻塞 tokio 线程）。
async fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("投递到主线程失败：{e}"))?;
    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("主线程任务被丢弃".into()),
        Err(_) => Err("等待主线程超时".into()),
    }
}

fn check_id(id: &str) -> Result<(), String> {
    if hark_window::has_account(id) {
        Ok(())
    } else {
        Err("找不到这个 Hark 账号".into())
    }
}

// ---------------------------------------------------------------- 供其他模块用（主线程）

/// 在主线程上借用某账号的嵌入视图；没有（或正被借用）返回 None。
pub(crate) fn with_embed_view<R>(id: &str, f: impl FnOnce(&WebView) -> R) -> Option<R> {
    EMBEDS.with(|slot| {
        let store = slot.try_borrow().ok()?;
        store.get(id).map(|e| f(&e.view))
    })
}

/// 账号是否开着嵌入视图（任意线程）。
pub(crate) fn is_open(id: &str) -> bool {
    opened_mirror().lock().map(|m| m.contains(id)).unwrap_or(false)
}

/// 销毁某账号的嵌入视图（主线程调用，删除账号时用）。不存在时什么都不做。
pub(crate) fn destroy_on_main(id: &str) {
    EMBEDS.with(|slot| {
        if let Ok(mut store) = slot.try_borrow_mut() {
            store.remove(id);
            sync_mirror(&store);
        }
    });
}

/// 由 lib.rs 的全局 `on_window_event` 调用（主线程）：主窗口销毁时丢掉所有嵌入视图。
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == EMBED_HOST_LABEL && matches!(event, tauri::WindowEvent::Destroyed) {
        EMBEDS.with(|slot| {
            if let Ok(mut store) = slot.try_borrow_mut() {
                store.clear();
                sync_mirror(&store);
            }
        });
    }
}

// ---------------------------------------------------------------- 命令

/// 不存在则创建；设区域、显示并聚焦。区域不合法时只建不显示（隐藏）。
#[tauri::command]
pub async fn hark_embed_show(
    app: tauri::AppHandle,
    id: String,
    rect: EmbedRect,
) -> Result<(), String> {
    check_id(&id)?;
    let handle = app.clone();
    on_main(&app, move || {
        let window = handle
            .get_webview_window(EMBED_HOST_LABEL)
            .ok_or_else(|| "主窗口不存在".to_string())?;
        let bounds = rect.to_rect();
        // 先短借用判断是否已存在；建 WebView 时不持有借用（WebView2 创建期间会泵消息，
        // 期间可能有别的主线程任务来读 EMBEDS）。
        let exists = EMBEDS.with(|slot| slot.borrow().contains_key(&id));
        if !exists {
            let dir = hark_window::account_profile_dir(&id);
            let _ = std::fs::create_dir_all(&dir);
            let initial = bounds.unwrap_or(Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: LogicalSize::new(1.0, 1.0).into(),
            });
            let label = format!("hark-embed-{id}");
            #[cfg(target_os = "windows")]
            let entry = {
                let mut context = wry::WebContext::new(Some(dir));
                let view = hark_window::build_account_view_in(
                    &window,
                    &id,
                    &label,
                    initial,
                    &mut context,
                )?;
                EmbedView {
                    view,
                    _context: context,
                }
            };
            #[cfg(not(target_os = "windows"))]
            let entry = {
                let _ = dir;
                EmbedView {
                    view: hark_window::build_account_view_in(&window, &id, &label, initial)?,
                }
            };
            EMBEDS.with(|slot| {
                let mut store = slot.borrow_mut();
                // 并发的两次 show 都建了视图时保留先插入的，后建的直接丢弃。
                store.entry(id.clone()).or_insert(entry);
                sync_mirror(&store);
            });
        }
        EMBEDS.with(|slot| {
            let store = slot.borrow();
            let Some(embed) = store.get(&id) else {
                return Ok(());
            };
            match bounds {
                Some(bounds) => {
                    let _ = embed.view.set_bounds(bounds);
                    let _ = embed.view.set_visible(true);
                    let _ = embed.view.focus();
                }
                None => {
                    let _ = embed.view.set_visible(false);
                }
            }
            Ok(())
        })
    })
    .await
}

/// 只更新区域（不改可见性）；区域不合法时隐藏。不存在则忽略。
#[tauri::command]
pub async fn hark_embed_bounds(
    app: tauri::AppHandle,
    id: String,
    rect: EmbedRect,
) -> Result<(), String> {
    on_main(&app, move || {
        with_embed_view(&id, |view| match rect.to_rect() {
            Some(bounds) => {
                let _ = view.set_bounds(bounds);
            }
            None => {
                let _ = view.set_visible(false);
            }
        });
        Ok(())
    })
    .await
}

/// 隐藏（不销毁）。不存在则忽略。
#[tauri::command]
pub async fn hark_embed_hide(app: tauri::AppHandle, id: String) -> Result<(), String> {
    on_main(&app, move || {
        with_embed_view(&id, |view| {
            let _ = view.set_visible(false);
        });
        Ok(())
    })
    .await
}

/// 销毁。不存在则忽略。
#[tauri::command]
pub async fn hark_embed_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    on_main(&app, move || {
        destroy_on_main(&id);
        Ok(())
    })
    .await
}

/// 工具条按钮：back / forward / reload / home / devtools。不存在则忽略。
#[tauri::command]
pub async fn hark_embed_action(
    app: tauri::AppHandle,
    id: String,
    action: String,
) -> Result<(), String> {
    on_main(&app, move || {
        with_embed_view(&id, |view| hark_window::run_view_action(view, &action))
            .unwrap_or(Ok(()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> EmbedRect {
        EmbedRect {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn rect_validation() {
        assert!(r(0.0, 36.0, 800.0, 600.0).to_rect().is_some());
        assert!(r(0.0, 0.0, 0.5, 600.0).to_rect().is_none());
        assert!(r(0.0, 0.0, 800.0, 0.0).to_rect().is_none());
        assert!(r(f64::NAN, 0.0, 800.0, 600.0).to_rect().is_none());
        assert!(r(0.0, 0.0, f64::INFINITY, 600.0).to_rect().is_none());
    }

    #[test]
    fn rect_json_shape() {
        let rect: EmbedRect =
            serde_json::from_str(r#"{"x":10,"y":20.5,"width":300,"height":200}"#).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (10.0, 20.5, 300.0, 200.0));
    }
}
