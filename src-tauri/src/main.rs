#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Hark Desk：Codex 风格的 Hark 多账号桌面壳。
//! 一个窗口里放两类 WebView：
//!   - "ui"：本地界面（账号栏 + 项目树），铺满整个窗口；
//!   - "acct-<id>"：每个账号一个 Hark 官方页面，独立数据目录（登录各自保持），
//!     盖在界面右侧对话区上。云浏览器、卡片、上传等功能都是 Hark 页面本身的，原样可用。

use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};

use serde::Serialize;
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder}, window::WindowBuilder, AppHandle, LogicalPosition, LogicalSize,
    Manager, State, Webview, WebviewUrl, Window,
};

const HOME: &str = "https://hark.com/";

#[derive(Default, Clone, Copy)]
struct Pane {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Default)]
struct AppState {
    pane: Mutex<Pane>,
    current: Mutex<Option<String>>,
    /// 每个账号页面最新的 document.title（来自 on_document_title_changed）
    titles: Mutex<HashMap<String, String>>,
}

fn label(id: &str) -> String {
    format!("acct-{id}")
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn window(app: &AppHandle) -> Result<Window, String> {
    app.get_window("main").ok_or_else(|| "主窗口不存在".to_string())
}

fn account_views(app: &AppHandle) -> Vec<Webview> {
    app.webviews()
        .into_iter()
        .filter(|(l, _)| l.starts_with("acct-"))
        .map(|(_, w)| w)
        .collect()
}

fn place(view: &Webview, p: Pane) -> Result<(), String> {
    view.set_position(LogicalPosition::new(p.x, p.y))
        .map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(p.w.max(1.0), p.h.max(1.0)))
        .map_err(|e| e.to_string())
}

/// Hark 页面里弹新窗口时：登录类弹窗留在应用里（共享同一个数据目录，登录才能写回），
/// 其余 target=_blank / window.open 一律交给系统默认浏览器。
fn keep_popup_inside(url: &tauri::Url) -> bool {
    if url.scheme() == "about" {
        return true; // 很多 OAuth 弹窗先开 about:blank 再跳转
    }
    let host = url.host_str().unwrap_or("");
    const AUTH_HOSTS: [&str; 5] = [
        "accounts.google.com",
        "appleid.apple.com",
        "login.microsoftonline.com",
        "login.live.com",
        "github.com",
    ];
    let is_hark = host == "hark.com" || host.ends_with(".hark.com");
    let is_auth = AUTH_HOSTS.contains(&host)
        && (host != "github.com" || url.path().starts_with("/login"));
    is_hark && (url.path().contains("auth") || url.path().contains("login") || url.path().contains("sso"))
        || is_auth
}

fn open_external(url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn css_script(css: &str) -> String {
    let css = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  var css = {css};
  if (!css) return;
  function add(){{
    if (document.getElementById('hark-desk-css')) return;
    var s = document.createElement('style');
    s.id = 'hark-desk-css';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
}})();"#
    )
}

/* ---------------- 界面状态（账号、项目、收藏）存成一个 JSON ---------------- */

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let f = data_dir(&app)?.join("state.json");
    Ok(fs::read_to_string(f).ok())
}

#[tauri::command]
fn save_state(app: AppHandle, state: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("state.json.tmp");
    fs::write(&tmp, state).map_err(|e| e.to_string())?;
    fs::rename(tmp, dir.join("state.json")).map_err(|e| e.to_string())
}

/* ---------------- 右侧对话区 ---------------- */

#[tauri::command]
fn set_pane(app: AppHandle, st: State<'_, AppState>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let p = Pane { x, y, w, h };
    *st.pane.lock().unwrap() = p;
    if let Some(id) = st.current.lock().unwrap().clone() {
        if let Some(v) = app.get_webview(&label(&id)) {
            place(&v, p)?;
        }
    }
    Ok(())
}

/// 显示某个账号的 Hark 页面；第一次打开时创建（独立数据目录）。
/// Windows 上在同步命令里建 WebView 会死锁，所以这里是 async。
#[tauri::command]
async fn show_account(
    app: AppHandle,
    st: State<'_, AppState>,
    id: String,
    url: Option<String>,
    css: Option<String>,
) -> Result<(), String> {
    let me = label(&id);
    for v in account_views(&app) {
        if v.label() != me {
            let _ = v.hide();
        }
    }
    *st.current.lock().unwrap() = Some(id.clone());
    let pane = *st.pane.lock().unwrap();

    if let Some(v) = app.get_webview(&me) {
        place(&v, pane)?;
        v.show().map_err(|e| e.to_string())?;
        if let Some(u) = url {
            v.navigate(u.parse().map_err(|e| format!("地址不对：{e}"))?)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let dir = data_dir(&app)?.join("profiles").join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let start = url.unwrap_or_else(|| HOME.to_string());
    let builder = WebviewBuilder::new(
        &me,
        WebviewUrl::External(start.parse().map_err(|e| format!("地址不对：{e}"))?),
    )
    .data_directory(dir)
    .initialization_script(&css_script(css.as_deref().unwrap_or("")))
    .on_document_title_changed(|wv, title| {
        if let Some(st) = wv.app_handle().try_state::<AppState>() {
            st.titles.lock().unwrap().insert(wv.label().to_string(), title);
        }
    })
    .on_new_window(|url, _features| {
        if keep_popup_inside(&url) {
            NewWindowResponse::Allow
        } else {
            open_external(&url);
            NewWindowResponse::Deny
        }
    });

    window(&app)?
        .add_child(
            builder,
            LogicalPosition::new(pane.x, pane.y),
            LogicalSize::new(pane.w.max(1.0), pane.h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 打开对话框时先藏起所有 Hark 页面（原生 WebView 会盖在界面上面）。
#[tauri::command]
fn hide_all(app: AppHandle) {
    for v in account_views(&app) {
        let _ = v.hide();
    }
}

#[tauri::command]
async fn navigate(app: AppHandle, st: State<'_, AppState>, id: String, url: String) -> Result<(), String> {
    show_account(app, st, id, Some(url), None).await
}

#[tauri::command]
fn reload(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(v) = app.get_webview(&label(&id)) {
        v.eval("location.reload()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct Page {
    url: String,
    title: String,
}

#[tauri::command]
fn current_page(app: AppHandle, st: State<'_, AppState>, id: String) -> Result<Page, String> {
    let me = label(&id);
    let v = app
        .get_webview(&me)
        .ok_or_else(|| "这个账号的页面还没打开".to_string())?;
    let url = v.url().map_err(|e| e.to_string())?.to_string();
    let title = st.titles.lock().unwrap().get(&me).cloned().unwrap_or_default();
    Ok(Page { url, title })
}

/// 删除账号：关掉页面并清掉它的登录数据。
#[tauri::command]
async fn remove_account(app: AppHandle, st: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(v) = app.get_webview(&label(&id)) {
        let _ = v.close();
    }
    st.titles.lock().unwrap().remove(&label(&id));
    {
        let mut cur = st.current.lock().unwrap();
        if cur.as_deref() == Some(id.as_str()) {
            *cur = None;
        }
    }
    let dir = data_dir(&app)?.join("profiles").join(&id);
    // WebView2 进程可能还没完全退出，删不掉就留给下次启动清理
    if fs::remove_dir_all(&dir).is_err() {
        let _ = fs::write(dir.join(".delete-me"), b"");
    }
    Ok(())
}

/// 改了注入样式后重建所有账号页面（登录数据在磁盘上，不受影响）。
#[tauri::command]
fn reset_webviews(app: AppHandle) {
    for v in account_views(&app) {
        let _ = v.close();
    }
}

fn cleanup_deleted(app: &AppHandle) {
    if let Ok(dir) = data_dir(app) {
        if let Ok(rd) = fs::read_dir(dir.join("profiles")) {
            for e in rd.flatten() {
                if e.path().join(".delete-me").exists() {
                    let _ = fs::remove_dir_all(e.path());
                }
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            cleanup_deleted(app.handle());
            let win = WindowBuilder::new(app, "main")
                .title("Hark Desk")
                .inner_size(1320.0, 860.0)
                .min_inner_size(960.0, 600.0)
                .build()?;
            let scale = win.scale_factor()?;
            let size = win.inner_size()?.to_logical::<f64>(scale);
            win.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())).auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            set_pane,
            show_account,
            hide_all,
            navigate,
            reload,
            current_page,
            remove_account,
            reset_webviews
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
