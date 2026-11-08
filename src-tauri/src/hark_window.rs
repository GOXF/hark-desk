//! Hark 账号窗口（方案 A：独立窗口）。
//!
//! 做法照搬 Hark Hub Go：宿主直接建 WebView2，每个 Hark 账号一个独立的数据目录
//! （`<数据目录>/hark-profiles/<id>`），不经过内置浏览器插件。
//!
//! - 只有一个窗口 `hark-window`：它自己的 WebView 加载前端 `/hark-window`，
//!   只画顶部的账号切换条（高 [`BAR_HEIGHT`]）；
//! - 每个账号的 hark.com 是挂在这个窗口上的 wry 子 WebView，放在切换条下面，
//!   切换账号 = 显示一个、隐藏其他；
//! - 账号列表存在 `<数据目录>/hark-accounts.json`；窗口位置大小存在
//!   `<数据目录>/hark-window.json`，下次打开恢复；
//! - hark.com 页面没有任何 IPC（不注册 ipc handler，capability 也不含它），
//!   Agent / 插件都碰不到它。
//!
//! WebView 不是 Send，全部放在主线程的 thread_local 里；所有创建、显示、
//! 销毁都通过 `run_on_main_thread` 在主线程做（不能在 IPC 回调里同步建第二个
//! WebView2 环境，见 `app_windows::app_webview_data_directory` 的说明）。

use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock, mpsc},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_runtime_wry::wry::{
    self, Rect, WebView, WebViewBuilder,
    dpi::{LogicalPosition, LogicalSize},
};

pub const HARK_WINDOW_LABEL: &str = "hark-window";
pub const HARK_ACCOUNTS_EVENT: &str = "hark-accounts-changed";
const HARK_HOME_URL: &str = "https://hark.com/";
const ACCOUNT_PREFIX: &str = "hark-";
/// 顶部切换条高度（逻辑像素），要和前端 HarkWindowBar 的高度一致。
pub const BAR_HEIGHT: f64 = 40.0;

// ---------------------------------------------------------------- 账号列表

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarkAccount {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsFile {
    #[serde(default)]
    accounts: Vec<HarkAccount>,
    #[serde(default)]
    active: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarkAccountsState {
    pub accounts: Vec<HarkAccount>,
    /// 窗口里当前显示的账号（或上次显示的）。
    pub active: Option<String>,
    /// 已经在窗口里打开过（有 WebView）的账号。
    pub opened: Vec<String>,
    pub window_open: bool,
}

fn data_root() -> PathBuf {
    utils::assets::host_data_dir()
}

fn accounts_path() -> PathBuf {
    data_root().join("hark-accounts.json")
}

fn geometry_path() -> PathBuf {
    data_root().join("hark-window.json")
}

fn profile_dir(id: &str) -> PathBuf {
    data_root().join("hark-profiles").join(id)
}

fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_accounts() -> AccountsFile {
    std::fs::read_to_string(accounts_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_accounts(file: &AccountsFile) -> Result<(), String> {
    let path = accounts_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("保存账号列表失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存账号列表失败：{e}"))
}

fn valid_id(id: &str) -> bool {
    id.starts_with(ACCOUNT_PREFIX)
        && id.len() > ACCOUNT_PREFIX.len()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ---------------------------------------------------------------- 主线程上的 WebView

struct Surfaces {
    views: HashMap<String, WebView>,
    #[cfg(target_os = "windows")]
    contexts: HashMap<String, wry::WebContext>,
    active: Option<String>,
}

thread_local! {
    static SURFACES: RefCell<Surfaces> = RefCell::new(Surfaces {
        views: HashMap::new(),
        #[cfg(target_os = "windows")]
        contexts: HashMap::new(),
        active: None,
    });
}

/// 前端读状态时要知道哪些账号已经开着；主线程外只能读这份镜像。
fn opened_mirror() -> &'static Mutex<Vec<String>> {
    static M: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(Vec::new()))
}

fn sync_mirror(store: &Surfaces) {
    if let Ok(mut m) = opened_mirror().lock() {
        *m = store.views.keys().cloned().collect();
    }
}

fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

fn content_rect(window: &tauri::WebviewWindow) -> Rect {
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((1100.0, 800.0));
    Rect {
        position: LogicalPosition::new(0.0, BAR_HEIGHT).into(),
        size: LogicalSize::new(w.max(1.0), (h - BAR_HEIGHT).max(1.0)).into(),
    }
}

fn layout(window: &tauri::WebviewWindow, store: &Surfaces) {
    let rect = content_rect(window);
    for (id, view) in &store.views {
        let visible = store.active.as_deref() == Some(id.as_str());
        if visible {
            let _ = view.set_bounds(rect);
        }
        let _ = view.set_visible(visible);
    }
    if let Some(active) = store.active.as_ref().and_then(|id| store.views.get(id)) {
        let _ = active.focus();
    }
}

fn build_account_view(
    window: &tauri::WebviewWindow,
    id: &str,
    #[cfg(target_os = "windows")] context: &mut wry::WebContext,
) -> Result<WebView, String> {
    #[cfg(target_os = "windows")]
    let builder = WebViewBuilder::new_with_web_context(context);
    #[cfg(not(target_os = "windows"))]
    let builder = WebViewBuilder::new();
    let label = format!("hark-account-{id}");
    let mut builder = builder
        .with_id(&label)
        .with_url(HARK_HOME_URL)
        .with_bounds(content_rect(window))
        .with_visible(false)
        .with_devtools(true)
        .with_hotkeys_zoom(true)
        // 外链（target=_blank 之外的跨站跳转）仍在本窗口里打开；hark.com 的
        // 登录跳转（Google 等）需要留在同一个 WebView 里才能回写 Cookie。
        .with_navigation_handler(|url| url.starts_with("http://") || url.starts_with("https://"))
        .with_new_window_req_handler(|url, _features| {
            // 登录弹窗（Google / Apple / 微软 / hark.com 自己）用 WebView2 默认弹窗，
            // 与本账号共用同一环境和 Cookie；其他链接交给系统浏览器。
            if keeps_in_app(&url) {
                wry::NewWindowResponse::Allow
            } else {
                open_system_browser(&url);
                wry::NewWindowResponse::Deny
            }
        });
    if let Some(config) =
        crate::browser_native::inherited_proxy_url()
            .and_then(|u| crate::browser_native::proxy_config_from_url(&u))
    {
        builder = builder.with_proxy_config(config);
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_runtime_wry::wry::WebViewBuilderExtDarwin;
        builder = builder.with_data_store_identifier(data_store_identifier(id));
    }
    builder.build_as_child(window).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn data_store_identifier(id: &str) -> [u8; 16] {
    const NS: uuid::Uuid = uuid::Uuid::from_bytes([
        0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30,
        0xc8,
    ]);
    uuid::Uuid::new_v5(&NS, format!("https://hark.com/desk-account/{id}").as_bytes()).into_bytes()
}

fn keeps_in_app(url: &str) -> bool {
    if url.is_empty() || url == "about:blank" {
        return true;
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    const HOSTS: &[&str] = &[
        "hark.com",
        "accounts.google.com",
        "appleid.apple.com",
        "login.microsoftonline.com",
        "login.live.com",
        "github.com",
    ];
    HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

fn open_system_browser(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

// ---------------------------------------------------------------- 窗口

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
}

fn read_geometry() -> Option<Geometry> {
    let raw = std::fs::read_to_string(geometry_path()).ok()?;
    let g: Geometry = serde_json::from_str(&raw).ok()?;
    (g.width >= 400.0 && g.height >= 300.0).then_some(g)
}

fn save_geometry(window: &tauri::Window) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized || window.is_minimized().unwrap_or(false) {
        // 最大化 / 最小化时只记标记，保留上次的正常大小。
        let mut g = read_geometry().unwrap_or(Geometry {
            x: 120.0,
            y: 80.0,
            width: 1100.0,
            height: 800.0,
            maximized,
        });
        g.maximized = maximized;
        let _ = std::fs::write(geometry_path(), serde_json::to_string(&g).unwrap_or_default());
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let g = Geometry {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        maximized: false,
    };
    let _ = std::fs::write(geometry_path(), serde_json::to_string(&g).unwrap_or_default());
}

fn ensure_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(HARK_WINDOW_LABEL) {
        return Ok(window);
    }
    let geometry = read_geometry();
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        HARK_WINDOW_LABEL,
        tauri::WebviewUrl::App("/hark-window".into()),
    )
    .title("Hark")
    .min_inner_size(480.0, 360.0)
    .resizable(true)
    .visible(true);
    builder = match geometry {
        Some(g) => builder.inner_size(g.width, g.height).position(g.x, g.y),
        None => builder.inner_size(1100.0, 800.0).center(),
    };
    if let Some(dir) = crate::app_windows::app_webview_data_directory(HARK_WINDOW_LABEL) {
        builder = builder.data_directory(dir);
    }
    if let Ok(icon) = crate::load_app_icon() {
        builder = builder.icon(icon).map_err(|e| e.to_string())?;
    }
    let window = builder.build().map_err(|e| format!("创建 Hark 窗口失败：{e}"))?;
    if geometry.is_some_and(|g| g.maximized) {
        let _ = window.maximize();
    }
    Ok(window)
}

/// 由 lib.rs 的全局 `on_window_event` 调用（主线程）。
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != HARK_WINDOW_LABEL {
        return;
    }
    match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(wv) = window.app_handle().get_webview_window(HARK_WINDOW_LABEL) {
                SURFACES.with(|slot| {
                if let Ok(store) = slot.try_borrow() {
                    layout(&wv, &store);
                }
            });
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => save_geometry(window),
        tauri::WindowEvent::Destroyed => {
            SURFACES.with(|slot| {
                let Ok(mut store) = slot.try_borrow_mut() else {
                    return;
                };
                store.views.clear();
                #[cfg(target_os = "windows")]
                store.contexts.clear();
                sync_mirror(&store);
            });
            emit_state(window.app_handle());
        }
        _ => {}
    }
}

fn current_state(app: &tauri::AppHandle) -> HarkAccountsState {
    let file = read_accounts();
    HarkAccountsState {
        accounts: file.accounts,
        active: file.active,
        opened: opened_mirror().lock().map(|m| m.clone()).unwrap_or_default(),
        window_open: app.get_webview_window(HARK_WINDOW_LABEL).is_some(),
    }
}

fn emit_state(app: &tauri::AppHandle) {
    let _ = app.emit(HARK_ACCOUNTS_EVENT, current_state(app));
}

fn set_active_in_file(id: &str) {
    let _g = file_lock().lock();
    let mut file = read_accounts();
    if file.active.as_deref() != Some(id) {
        file.active = Some(id.to_owned());
        let _ = write_accounts(&file);
    }
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub async fn hark_accounts_state(app: tauri::AppHandle) -> Result<HarkAccountsState, String> {
    Ok(current_state(&app))
}

#[tauri::command]
pub async fn hark_accounts_add(
    app: tauri::AppHandle,
    name: Option<String>,
) -> Result<HarkAccount, String> {
    let account = {
        let _g = file_lock().lock();
        let mut file = read_accounts();
        let now = chrono::Utc::now();
        // 同一毫秒内重复添加时往后挪一位，保证 id 唯一。
        let mut stamp = now.timestamp_millis() as u64;
        let mut id = format!("{ACCOUNT_PREFIX}{}", radix36(stamp));
        while file.accounts.iter().any(|a| a.id == id) {
            stamp += 1;
            id = format!("{ACCOUNT_PREFIX}{}", radix36(stamp));
        }
        let name = name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("账号 {}", file.accounts.len() + 1));
        let account = HarkAccount {
            id,
            name,
            created_at: now.timestamp(),
        };
        file.accounts.push(account.clone());
        write_accounts(&file)?;
        account
    };
    let _ = std::fs::create_dir_all(profile_dir(&account.id));
    emit_state(&app);
    Ok(account)
}

#[tauri::command]
pub async fn hark_accounts_rename(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    {
        let _g = file_lock().lock();
        let mut file = read_accounts();
        let account = file
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("找不到这个账号")?;
        account.name = name;
        write_accounts(&file)?;
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub async fn hark_accounts_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("账号 id 无效".into());
    }
    let close_id = id.clone();
    let _ = on_main(&app, move || {
        SURFACES.with(|slot| {
            let mut store = slot.borrow_mut();
            store.views.remove(&close_id);
            #[cfg(target_os = "windows")]
            store.contexts.remove(&close_id);
            if store.active.as_deref() == Some(close_id.as_str()) {
                store.active = None;
            }
            sync_mirror(&store);
        });
        Ok(())
    });
    {
        let _g = file_lock().lock();
        let mut file = read_accounts();
        file.accounts.retain(|a| a.id != id);
        if file.active.as_deref() == Some(id.as_str()) {
            file.active = file.accounts.first().map(|a| a.id.clone());
        }
        write_accounts(&file)?;
    }
    // WebView2 进程退出前目录可能还被占用，稍后重试几次。
    let dir = profile_dir(&id);
    tauri::async_runtime::spawn(async move {
        for _ in 0..10 {
            if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        }
    });
    if let Some(window) = app.get_webview_window(HARK_WINDOW_LABEL) {
        let next = read_accounts().active;
        match next {
            Some(next) => {
                let _ = show_account(&app, &window, next);
            }
            None => {
                let _ = window.close();
            }
        }
    }
    emit_state(&app);
    Ok(())
}

fn show_account(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    let w = window.clone();
    let show_id = id.clone();
    on_main(app, move || {
        SURFACES.with(|slot| {
            let mut store = slot.borrow_mut();
            if !store.views.contains_key(&show_id) {
                let dir = profile_dir(&show_id);
                let _ = std::fs::create_dir_all(&dir);
                #[cfg(target_os = "windows")]
                let view = {
                    let context = store
                        .contexts
                        .entry(show_id.clone())
                        .or_insert_with(|| wry::WebContext::new(Some(dir)));
                    build_account_view(&w, &show_id, context)?
                };
                #[cfg(not(target_os = "windows"))]
                let view = {
                    let _ = dir;
                    build_account_view(&w, &show_id)?
                };
                store.views.insert(show_id.clone(), view);
            }
            store.active = Some(show_id.clone());
            layout(&w, &store);
            sync_mirror(&store);
            Ok(())
        })
    })?;
    set_active_in_file(&id);
    let _ = window.set_title(&format!(
        "Hark · {}",
        read_accounts()
            .accounts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.name.clone())
            .unwrap_or_default()
    ));
    Ok(())
}

/// 打开 Hark 窗口并切到 `id`（缺省 = 上次的账号，或第一个账号）。
#[tauri::command]
pub async fn hark_window_open(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let file = read_accounts();
    let id = id
        .or(file.active.clone())
        .filter(|id| file.accounts.iter().any(|a| &a.id == id))
        .or_else(|| file.accounts.first().map(|a| a.id.clone()))
        .ok_or("还没有 Hark 账号，先添加一个")?;
    if !valid_id(&id) {
        return Err("账号 id 无效".into());
    }
    let handle = app.clone();
    let window = on_main(&app, move || ensure_window(&handle))?;
    show_account(&app, &window, id)?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    emit_state(&app);
    Ok(())
}

/// 切换条上的按钮：back / forward / reload / home / devtools。
#[tauri::command]
pub async fn hark_window_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    on_main(&app, move || {
        SURFACES.with(|slot| {
            let store = slot.borrow();
            let Some(view) = store.active.as_ref().and_then(|id| store.views.get(id)) else {
                return Ok(());
            };
            let result = match action.as_str() {
                "back" => view.evaluate_script("history.back()"),
                "forward" => view.evaluate_script("history.forward()"),
                "reload" => view.reload(),
                "home" => view.load_url(HARK_HOME_URL),
                "devtools" => {
                    #[cfg(target_os = "windows")]
                    {
                        use tauri_runtime_wry::wry::WebViewExtWindows;
                        unsafe {
                            let core = view.webview();
                            if let Ok(settings) = core.Settings() {
                                let _ = settings.SetAreDevToolsEnabled(true);
                            }
                            let _ = core.OpenDevToolsWindow();
                        }
                    }
                    // open_devtools 只在 debug_assertions 下存在（release 没开 devtools 特性）
                    #[cfg(all(not(target_os = "windows"), debug_assertions))]
                    view.open_devtools();
                    Ok(())
                }
                other => return Err(format!("未知操作：{other}")),
            };
            result.map_err(|e| e.to_string())
        })
    })
}

fn radix36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_checked() {
        assert!(valid_id("hark-mh3k2a"));
        assert!(!valid_id("hark-"));
        assert!(!valid_id("hark-../x"));
        assert!(!valid_id("other"));
        assert_eq!(radix36(35), "z");
        assert_eq!(radix36(36), "10");
        assert!(keeps_in_app("https://accounts.google.com/o/oauth2"));
        assert!(keeps_in_app("https://www.hark.com/x"));
        assert!(!keeps_in_app("https://evilhark.com/"));
        assert!(!keeps_in_app("https://example.com/"));
    }
}
