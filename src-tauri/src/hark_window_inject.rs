//! Hark 独立窗口（`hark_window`）账号 WebView 的两项注入。
//!
//! 1. **云电脑画面放大 / 弹出**：`hark_liveview.js`（来自 PR #2 `wip/hark-liveview`
//!    498fc2d4，原样拷贝）作为 initialization script 挂到每个账号 WebView 上，
//!    由 `hark_window::build_account_view` 里的一行钩子调用
//!    [`decorate_account_builder`]。脚本自己判断 `location.hostname`，只在
//!    hark.com 及其子域生效；这里再用 `for_main_frame_only = true`
//!    （注意 Windows 上 wry 会忽略这个参数，子框架也会注入，靠脚本内的域名判断兜底）。
//!
//! 2. **文件桥页面求值**：`hark_bridge_inject` 原来只认内置浏览器
//!    （`BrowserService::host_eval_on_origin`）。Hark 账号改成宿主直建的 wry 子
//!    WebView 后，那条路找不到这些账号，所以这里提供同样语义的原语：
//!    - [`eval_on_origin`]：在账号 WebView（或后台 WebView）上求值，要求页面当前
//!      origin 等于期望 origin；主线程上调 wry `evaluate_script_with_callback`，
//!      结果经 oneshot 传回，带超时；
//!    - [`view_url`]：读当前地址；
//!    - [`open_background`] / [`close_background`]：在 Hark 窗口上为同一账号开一个
//!      隐藏的子 WebView（同一数据目录 = 同一登录状态），用完销毁——等价于原来的
//!      后台标签，不把用户正在看的页面导航走。
//!
//! WebView 不是 Send，只存在主线程的 thread_local 里：账号 WebView 在
//! `hark_window` 的 `SURFACES`，后台 WebView 在本文件的 [`BACKGROUND`]。
//! 所有访问都经 `AppHandle::run_on_main_thread`，异步等待结果，不阻塞主线程。
//!
//! 后台 WebView 没有 IPC、不允许开新窗口，Agent / 插件都碰不到。

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::Manager;
use tauri_runtime_wry::wry::{self, PageLoadEvent, WebView, WebViewBuilder};

use crate::hark_window::{self, HARK_WINDOW_LABEL};

/// hark.com 云电脑画面「放大 / 弹出」按钮，脚本内部自行判断域名（来自 PR #2）。
const HARK_LIVEVIEW_SCRIPT: &str = include_str!("hark_liveview.js");

/// `build_account_view` 的钩子：给账号 WebView 加上 hark.com 注入脚本。
pub(crate) fn decorate_account_builder(builder: WebViewBuilder<'_>) -> WebViewBuilder<'_> {
    builder.with_initialization_script_for_main_only(HARK_LIVEVIEW_SCRIPT, true)
}

// ---------------------------------------------------------------- 求值目标

/// 要在哪个 WebView 上操作。
#[derive(Clone, Debug)]
pub(crate) enum ViewRef {
    /// 某账号的可见 WebView（用户正在用的那个）：Hark 窗口（A）里的优先，其次主窗口嵌入标签（B）。
    Account(String),
    /// 本文件开的后台 WebView（[`open_background`] 返回的令牌）。
    Background(String),
}

impl ViewRef {
    /// 日志用的简短标识（不含地址）。
    pub(crate) fn label(&self) -> String {
        match self {
            ViewRef::Account(id) => format!("hark-window:{id}"),
            ViewRef::Background(token) => format!("hark-window-bg:{token}"),
        }
    }
}

/// 后台 WebView：令牌 → (WebView, Windows 上配套的 WebContext)。只在主线程访问。
struct BackgroundView {
    view: WebView,
    #[cfg(target_os = "windows")]
    _context: wry::WebContext,
}

thread_local! {
    static BACKGROUND: RefCell<HashMap<String, BackgroundView>> = RefCell::new(HashMap::new());
}

/// 在主线程上借用目标 WebView。
fn with_view<R>(target: &ViewRef, f: impl FnOnce(&WebView) -> R) -> Option<R> {
    match target {
        ViewRef::Account(id) => hark_window::with_account_view(id, f),
        ViewRef::Background(token) => BACKGROUND.with(|slot| {
            let store = slot.try_borrow().ok()?;
            store.get(token).map(|bg| f(&bg.view))
        }),
    }
}

/// 把 `f` 放到主线程上跑，异步等它的返回值。
async fn on_main_async<T: Send + 'static>(
    app: &tauri::AppHandle,
    timeout: Duration,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("投递到主线程失败：{e}"))?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("主线程任务被丢弃".into()),
        Err(_) => Err("等待主线程超时".into()),
    }
}

fn origin_of_str(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| browser_host::grant::origin_of(&u))
}

// ---------------------------------------------------------------- 路由

/// 文件桥该不该走 Hark 窗口：账号在 Hark 窗口的账号列表里，且窗口开着（账号 WebView
/// 没打开时也能在窗口上开后台 WebView）。返回 false 时调用方回退内置浏览器的老路径。
/// 账号只在主窗口嵌入标签（B 方案）里开着时也算（后台 WebView 改挂在主窗口上）。
pub(crate) fn can_serve(app: &tauri::AppHandle, id: &str) -> bool {
    hark_window::has_account(id)
        && (app.get_webview_window(HARK_WINDOW_LABEL).is_some()
            || crate::hark_embed::is_open(id))
}

/// 后台 WebView 挂在哪个窗口：优先 Hark 窗口，否则（账号只在嵌入标签里开着）主窗口。
fn background_host(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(HARK_WINDOW_LABEL)
        .or_else(|| app.get_webview_window(crate::hark_embed::EMBED_HOST_LABEL))
}

/// 读目标 WebView 当前地址；WebView 不存在返回 None。
pub(crate) async fn view_url(app: &tauri::AppHandle, target: &ViewRef) -> Option<String> {
    let target = target.clone();
    on_main_async(app, Duration::from_secs(5), move || {
        Ok(with_view(&target, |view| view.url().ok()).flatten())
    })
    .await
    .ok()
    .flatten()
}

/// 在目标 WebView 上求值，返回引擎给回调的原始 JSON 字符串（调用方用
/// `browser_host::agent::decode_eval_result` 解一层字符串）。
///
/// 要求页面当前 origin 等于 `origin`，否则不执行（与 `host_eval_on_origin` 同语义）。
/// 脚本必须是同步的：WebView2 / WKWebView 都不会等 Promise。
pub(crate) async fn eval_on_origin(
    app: &tauri::AppHandle,
    target: &ViewRef,
    origin: &str,
    script: &str,
    timeout: Duration,
) -> Result<String, String> {
    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<String>();
    // wry 的回调是 `Fn`，用 Mutex<Option<..>> 保证只发一次。
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));
    let target_main = target.clone();
    let origin = origin.to_owned();
    let script = script.to_owned();
    on_main_async(app, timeout, move || {
        with_view(&target_main, move |view| {
            let current = view.url().map_err(|e| format!("读取页面地址失败：{e}"))?;
            if origin_of_str(&current).as_deref() != Some(origin.as_str()) {
                return Err("页面已不在目标站点上，拒绝求值".to_string());
            }
            let tx = result_tx.clone();
            view.evaluate_script_with_callback(&script, move |raw| {
                if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(raw);
                }
            })
            .map_err(|e| format!("页面求值失败：{e}"))
        })
        .unwrap_or_else(|| Err("Hark 窗口里没有这个 WebView（可能已关闭）".to_string()))
    })
    .await?;
    match tokio::time::timeout(timeout, result_rx).await {
        Ok(Ok(raw)) => Ok(raw),
        // WebView 被销毁 / macOS 页面未就绪时脚本被挂起，回调不会来
        Ok(Err(_)) => Err("页面求值没有返回（WebView 已关闭）".into()),
        Err(_) => Err("页面求值超时".into()),
    }
}

// ---------------------------------------------------------------- 后台 WebView

/// 在 Hark 窗口上为账号 `id` 开一个隐藏的子 WebView 打开 `url`，等首屏加载
/// （最多 `first_load_wait`，之后调用方还有输入框轮询兜底），返回令牌。
///
/// 与账号 WebView 共用数据目录（Windows：同一 user data folder；macOS：同一
/// data store identifier），代理设置也一样，保证 WebView2 环境参数一致。
pub(crate) async fn open_background(
    app: &tauri::AppHandle,
    id: &str,
    url: &str,
    first_load_wait: Duration,
) -> Result<ViewRef, String> {
    let token = format!("{id}-{}", uuid::Uuid::new_v4().simple());
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
    let handle = app.clone();
    let id_main = id.to_owned();
    let url_main = url.to_owned();
    let token_main = token.clone();
    on_main_async(app, Duration::from_secs(15), move || {
        let window =
            background_host(&handle).ok_or_else(|| "Hark 窗口没有打开".to_string())?;
        let dir = hark_window::account_profile_dir(&id_main);
        let _ = std::fs::create_dir_all(&dir);
        #[cfg(target_os = "windows")]
        let mut context = wry::WebContext::new(Some(dir));
        #[cfg(target_os = "windows")]
        let builder = WebViewBuilder::new_with_web_context(&mut context);
        #[cfg(not(target_os = "windows"))]
        let builder = {
            let _ = dir;
            WebViewBuilder::new()
        };
        let label = format!("hark-bridge-bg-{token_main}");
        let loaded = loaded_tx.clone();
        let mut builder = builder
            .with_id(&label)
            .with_url(&url_main)
            .with_bounds(hark_window::account_content_rect(&window))
            .with_visible(false)
            .with_devtools(false)
            .with_navigation_handler(|u| u.starts_with("http://") || u.starts_with("https://"))
            // 后台页面不许开任何新窗口
            .with_new_window_req_handler(|_url, _features| wry::NewWindowResponse::Deny)
            .with_on_page_load_handler(move |event, _url| {
                if matches!(event, PageLoadEvent::Finished)
                    && let Some(tx) = loaded.lock().ok().and_then(|mut slot| slot.take())
                {
                    let _ = tx.send(());
                }
            });
        if let Some(config) = crate::browser_native::inherited_proxy_url()
            .and_then(|u| crate::browser_native::proxy_config_from_url(&u))
        {
            builder = builder.with_proxy_config(config);
        }
        #[cfg(target_os = "macos")]
        {
            use tauri_runtime_wry::wry::WebViewBuilderExtDarwin;
            builder = builder
                .with_data_store_identifier(hark_window::account_data_store_identifier(&id_main));
        }
        let view = builder
            .build_as_child(&window)
            .map_err(|e| format!("后台页面创建失败：{e}"))?;
        BACKGROUND.with(|slot| {
            slot.borrow_mut().insert(
                token_main,
                BackgroundView {
                    view,
                    #[cfg(target_os = "windows")]
                    _context: context,
                },
            );
        });
        Ok(())
    })
    .await?;
    // 首屏没等到也继续：后面有输入框轮询兜底
    let _ = tokio::time::timeout(first_load_wait, loaded_rx).await;
    Ok(ViewRef::Background(token))
}

/// 销毁后台 WebView（账号 WebView 不受影响）。
pub(crate) async fn close_background(
    app: &tauri::AppHandle,
    target: &ViewRef,
) -> Result<(), String> {
    let ViewRef::Background(token) = target else {
        return Ok(());
    };
    let token = token.clone();
    on_main_async(app, Duration::from_secs(5), move || {
        BACKGROUND.with(|slot| {
            slot.borrow_mut().remove(&token);
        });
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liveview_script_is_embedded_and_host_guarded() {
        assert!(HARK_LIVEVIEW_SCRIPT.contains("__harkLiveviewInstalled"));
        assert!(HARK_LIVEVIEW_SCRIPT.contains("hark.com"));
    }

    #[test]
    fn origin_parsing() {
        assert_eq!(
            origin_of_str("https://hark.com/project/abc?x=1").as_deref(),
            Some("https://hark.com")
        );
        assert_eq!(origin_of_str("about:blank"), None);
    }
}
