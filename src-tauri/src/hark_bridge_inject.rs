//! 把文件桥连接消息自动发进某个 Hark 账号的项目聊天。
//!
//! 行为照搬 Hark Hub（`cmd/harkhub/mod_bridge_chat.go`、
//! `mod_project_bridge_connect.go`，分支 fix/bridge-connect-simple）：
//!
//! 1. 在该账号（内置浏览器 profile，id 以 `hark-` 开头）已登记的标签页里，
//!    找一个**已经停在目标项目页**、输入框空闲的标签直接用；
//! 2. 否则在同一个 profile 里开一个后台标签（不进界面、grant=none）打开项目地址，
//!    用完关掉——不把用户正在看的标签导航走，也不碰用户的草稿；
//! 3. 等输入框出现（composerJS；输入框里已经有内容 = 忙，直接报错，不覆盖草稿）；
//! 4. 对话里已经有这条连接地址就视为已连接，不重复发；
//! 5. 填入文字（textarea 用原生 value setter + input 事件；contenteditable 用
//!    insertText），点发送（clickSendJS）；
//! 6. 每秒用 inPageJS(marker_url) 回读，20 秒内对话里出现该地址才算成功。
//!
//! ## 为什么用 `BrowserService::host_eval_on_origin`（= wry `evaluate_script_with_callback`）
//!
//! VibeX 的内置浏览器标签都是宿主进程里的 wry WebView，登记在 browser-host 的
//! `BrowserService` 里。页面求值有两条现成路：
//!
//! - 插件 / Agent 的 `browser_eval`（`dispatch` → `eval_ask`/`eval_run`）：要求
//!   eval 总开关、`control` 级 share grant，并且**每一条**代码都弹窗让人确认，
//!   代码还限 4000 字。它是给 Agent 的，宿主后台自动发消息走不通，也不该走。
//! - `NativeTabs::eval`：桌面端实现就是在主线程上对该标签的 wry `WebView` 调
//!   `evaluate_script_with_callback`，把引擎的 JSON 结果用 oneshot 传回来。
//!   `snapshot`、`tab.chrome` 等宿主自己的读取都用它。
//!
//! 我们需要的是第二条，但 `native` 是 `BrowserService` 的私有字段，WebView 也只
//! 存在主线程的 thread_local 里，宿主代码拿不到。所以在 browser-host 里加了几个
//! 只给宿主 Rust 代码用的方法（`host_tabs_of_profile` / `host_open_background_tab` /
//! `host_close_tab` / `host_eval_on_origin`）：它们不出现在 `dispatch` 里，插件和
//! Agent 调不到；Agent 侧的 grant / 确认规则一条没改。hark.com 标签的 grant 即使是
//! none 也不影响这里——放行的只是宿主自己发起的这一次调用，且要求标签当前 origin
//! 等于项目地址的 origin。后台标签本身 grant 固定为 none，Agent 碰不到它。
//!
//! 所有脚本都是同步的、返回 `JSON.stringify(...)`：WebView2 的 ExecuteScript 和
//! WKWebView 的 evaluateJavaScript 都不会等 Promise，异步脚本拿回来的是 `{}`。
//!
//! 日志只记 profile、标签 id、长度和阶段，不记消息正文和连接地址（里面有密钥）。

use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use browser_host::{BrowserBounds, BrowserService};
use serde_json::{Value, json};
use tauri::Manager;
use url::Url;

use crate::browser_native::HostBrowserService;

/// 单次页面求值的超时。
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
/// 后台标签首屏加载最多等多久（之后还有输入框轮询兜底）。
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(15);
/// 等输入框出现：轮询次数 × 间隔（与 Hub 的 25 × 1s 一致）。
const COMPOSER_POLLS: usize = 25;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// 填入后等 React 把发送按钮点亮。
const FILL_SETTLE: Duration = Duration::from_millis(350);
/// 点击发送后回读确认的总时长。
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(20);
/// 点击后多久输入框里还留着原文就补点一次发送（只补一次）。
const RESEND_CLICK_AFTER: Duration = Duration::from_millis(1500);
/// 后台标签确认成功后再留一会儿，让消息真正提交到服务器再关（Hub 等 3 秒）。
const CLOSE_GRACE: Duration = Duration::from_secs(3);

/// 同一时间只投递一条，避免两次调用同时往一个输入框里填字。
fn send_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 把 `text` 发进 `profile_id` 这个 Hark 账号的 `project_url` 项目聊天，
/// 并确认对话里出现了 `marker_url`。
#[allow(dead_code)] // 由文件桥后台模块调用；接入前这里暂无调用方
pub async fn send_connect_message(
    app: &tauri::AppHandle,
    profile_id: &str,
    project_url: &str,
    text: &str,
    marker_url: &str,
) -> Result<(), String> {
    if cfg!(target_os = "linux") {
        // Linux 上标签是独立 WebviewWindow，`eval` 拿不到返回值（恒为 null），
        // 没法判断输入框状态和是否发出，宁可不做。
        return Err("Linux 版内置浏览器无法读取页面求值结果，暂不支持自动发送连接消息".into());
    }
    if !profile_id.starts_with("hark-") {
        return Err(format!("不是 Hark 账号的浏览器 profile：{profile_id}"));
    }
    if text.trim().is_empty() {
        return Err("连接消息为空".into());
    }
    if marker_url.trim().is_empty() {
        return Err("缺少用于回读确认的连接地址".into());
    }
    let target = parse_project_url(project_url)?;
    let origin = browser_host::grant::origin_of(&target)
        .ok_or_else(|| "项目地址不是 http(s) 地址".to_string())?;

    let service: Arc<BrowserService> = app
        .try_state::<HostBrowserService>()
        .map(|state| state.0.clone())
        .ok_or_else(|| "内置浏览器服务还没就绪".to_string())?;

    let _guard = send_lock().lock().await;
    let job = Job {
        origin,
        path: target.path().to_owned(),
        text: text.to_owned(),
        marker: marker_url.to_owned(),
        stamp: uuid::Uuid::new_v4().simple().to_string(),
    };
    tracing::info!(
        profile_id,
        text_len = text.chars().count(),
        "文件桥：开始向 Hark 项目聊天投递连接消息"
    );

    // 1) 复用已停在目标项目页、输入框空闲的标签
    for tab in service.host_tabs_of_profile(profile_id) {
        if tab.loading || !job.is_target_url(&tab.url) {
            continue;
        }
        match inspect(&service, &tab.tab_id, &job).await {
            Ok(Composer::Ready) => {
                tracing::info!(profile_id, tab_id = %tab.tab_id, "文件桥：复用已打开的项目标签");
                return deliver(&service, &tab.tab_id, &job, false).await;
            }
            Ok(state) => {
                tracing::info!(profile_id, tab_id = %tab.tab_id, ?state, "文件桥：已打开的项目标签不可用，改用后台标签");
            }
            Err(error) => {
                tracing::info!(profile_id, tab_id = %tab.tab_id, %error, "文件桥：已打开的项目标签求值失败，改用后台标签");
            }
        }
    }

    // 2) 后台标签：同一 profile（同一份登录状态），隐藏、grant=none、用完关闭
    let tab = service
        .host_open_background_tab(
            target.as_str(),
            profile_id,
            BrowserBounds::default(),
            FIRST_LOAD_WAIT,
        )
        .await
        .map_err(|error| format!("后台页面打不开：{error}"))?;
    tracing::info!(profile_id, tab_id = %tab.tab_id, "文件桥：已在后台标签打开项目页");
    let result = deliver(&service, &tab.tab_id, &job, true).await;
    if result.is_ok() {
        tokio::time::sleep(CLOSE_GRACE).await;
    }
    if let Err(error) = service.host_close_tab(&tab.tab_id).await {
        tracing::warn!(tab_id = %tab.tab_id, %error, "文件桥：关闭后台标签失败");
    }
    match &result {
        Ok(()) => tracing::info!(profile_id, "文件桥：连接消息已发送并回读确认"),
        Err(error) => tracing::warn!(profile_id, %error, "文件桥：连接消息投递失败"),
    }
    result
}

/// 一次投递要用到的参数。`stamp` 写进输入框的 data 属性，发送前核对草稿没被换掉。
struct Job {
    origin: String,
    path: String,
    text: String,
    marker: String,
    stamp: String,
}

impl Job {
    /// 某个地址是不是目标项目页（同 origin、同路径，忽略结尾斜杠、query、hash）。
    fn is_target_url(&self, raw: &str) -> bool {
        let Ok(url) = Url::parse(raw) else {
            return false;
        };
        browser_host::grant::origin_of(&url).as_deref() == Some(self.origin.as_str())
            && trim_slash(url.path()) == trim_slash(&self.path)
    }

    /// 注入脚本用的参数（JSON 字面量，直接是合法的 JS 表达式）。
    fn args(&self) -> String {
        json!({
            "origin": self.origin,
            "path": self.path,
            "text": self.text,
            "marker": self.marker,
            "stamp": self.stamp,
        })
        .to_string()
    }
}

fn trim_slash(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() { "/" } else { trimmed }
}

fn parse_project_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|error| format!("项目地址无效：{error}"))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !(host == "hark.com" || host.ends_with(".hark.com")) {
        return Err("项目地址必须是 https://hark.com 下的页面".into());
    }
    Ok(url)
}

#[derive(Debug, PartialEq, Eq)]
enum Composer {
    /// 在目标页、找到空输入框
    Ready,
    /// 输入框里已有内容（草稿 / 正在输入）
    Busy,
    /// 还没找到可用输入框（页面没加载完 / 没登录）
    Missing,
    /// 页面不在目标项目上（被重定向等）
    WrongPage,
}

/// 在页面里求值并把结果解析成 JSON。
async fn eval_json(
    service: &BrowserService,
    tab_id: &str,
    job: &Job,
    script: &str,
) -> Result<Value, String> {
    let raw = service
        .host_eval_on_origin(tab_id, &job.origin, script, EVAL_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?;
    let decoded = browser_host::agent::decode_eval_result(&raw);
    serde_json::from_str::<Value>(&decoded)
        .map_err(|error| format!("页面返回的结果无法解析：{error}"))
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

async fn inspect(service: &BrowserService, tab_id: &str, job: &Job) -> Result<Composer, String> {
    let value = eval_json(service, tab_id, job, &script(job, ACTION_INSPECT)).await?;
    Ok(if flag(&value, "wrongPage") {
        Composer::WrongPage
    } else if flag(&value, "busy") {
        Composer::Busy
    } else if flag(&value, "ok") {
        Composer::Ready
    } else {
        Composer::Missing
    })
}

async fn marker_in_page(service: &BrowserService, tab_id: &str, job: &Job) -> bool {
    match eval_json(service, tab_id, job, &script(job, ACTION_IN_PAGE)).await {
        Ok(value) => value.as_bool().unwrap_or(false),
        Err(_) => false,
    }
}

/// 在指定标签里完成「等输入框 → 去重 → 填入 → 发送 → 回读确认」。
async fn deliver(
    service: &BrowserService,
    tab_id: &str,
    job: &Job,
    wait_for_composer: bool,
) -> Result<(), String> {
    // 等输入框
    let polls = if wait_for_composer { COMPOSER_POLLS } else { 1 };
    let mut last = Composer::Missing;
    let mut last_error: Option<String> = None;
    for attempt in 0..polls {
        match inspect(service, tab_id, job).await {
            Ok(Composer::Ready) => {
                last = Composer::Ready;
                break;
            }
            Ok(Composer::Busy) => {
                return Err("项目聊天的输入框里已有内容（草稿或正在输入），为保留草稿已停止发送".into());
            }
            Ok(state) => last = state,
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < polls {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
    if last != Composer::Ready {
        return Err(match (last, last_error) {
            (Composer::WrongPage, _) => {
                "页面没有停在目标项目上（可能被重定向到登录页），已停止发送".into()
            }
            (_, Some(error)) => format!("没找到项目聊天输入框（可能未登录）：{error}"),
            _ => "没找到项目聊天输入框（可能未登录或页面没加载完）".into(),
        });
    }

    // 对话里已经有这条地址 = 之前发过了，不重复发
    if marker_in_page(service, tab_id, job).await {
        tracing::info!(tab_id, "文件桥：对话里已有该连接地址，视为已连接，不重发");
        return Ok(());
    }

    // 填入
    let filled = eval_json(service, tab_id, job, &script(job, ACTION_FILL)).await?;
    if flag(&filled, "busy") {
        return Err("项目聊天的输入框里已有内容（草稿或正在输入），为保留草稿已停止发送".into());
    }
    if !flag(&filled, "ok") {
        return Err(format!(
            "连接消息没能填进输入框（{}）",
            filled.get("code").and_then(Value::as_str).unwrap_or("unknown")
        ));
    }
    tokio::time::sleep(FILL_SETTLE).await;

    // 发送
    let sent = eval_json(service, tab_id, job, &script(job, ACTION_SEND)).await?;
    if !flag(&sent, "ok") {
        return Err(format!(
            "没能点击发送（{}），消息留在输入框里",
            sent.get("code").and_then(Value::as_str).unwrap_or("unknown")
        ));
    }
    let clicked_at = Instant::now();
    tracing::info!(tab_id, "文件桥：已点击发送，开始回读确认");

    // 回读确认：对话里出现连接地址才算成功
    let mut reclicked = false;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        if marker_in_page(service, tab_id, job).await {
            return Ok(());
        }
        if !reclicked && clicked_at.elapsed() >= RESEND_CLICK_AFTER {
            // 点完一会儿输入框里还原样留着这段文字 = 第一次点击没提交，补点一次（只补一次）
            if let Ok(left) = eval_json(service, tab_id, job, &script(job, ACTION_LEFT)).await
                && flag(&left, "same")
            {
                reclicked = true;
                tracing::info!(tab_id, "文件桥：输入框里仍是原文，补点一次发送");
                let _ = eval_json(service, tab_id, job, &script(job, ACTION_SEND)).await;
            }
        }
        if clicked_at.elapsed() >= CONFIRM_TIMEOUT {
            return Err("已点击发送，但 20 秒内没在对话里看到连接地址；为避免重复发送已停止".into());
        }
    }
}

const ACTION_INSPECT: &str = "inspect";
const ACTION_FILL: &str = "fill";
const ACTION_SEND: &str = "send";
const ACTION_LEFT: &str = "left";
const ACTION_IN_PAGE: &str = "inpage";

/// 拼出一次求值的脚本：公共部分（参数、目标页判断、找输入框）+ 具体动作。
/// 整段包在一个函数里，不在页面全局留名字；只有 `data-hark-bridge-stamp`
/// 属性会留在输入框上，发送后输入框被清空/重建也就没了。
fn script(job: &Job, action: &str) -> String {
    let body = match action {
        ACTION_INSPECT => INSPECT_JS,
        ACTION_FILL => FILL_JS,
        ACTION_SEND => SEND_JS,
        ACTION_LEFT => LEFT_JS,
        _ => IN_PAGE_JS,
    };
    format!(
        "(function(){{try{{\nvar P = {args};\n{PRELUDE_JS}\n{body}\n}}catch(e){{return JSON.stringify({{ok:false,code:'exception',error:String(e && e.message || e)}});}}}})()",
        args = job.args()
    )
}

/// 公共部分：目标页判断、输入框查找（= Hub 的 composerJS，优先 Hark 自己的
/// `textarea[aria-label="消息输入"]`）、读取输入框内容。
const PRELUDE_JS: &str = r#"
var norm = function (p) { p = (p || '').replace(/\/+$/, ''); return p || '/'; };
var onTarget = function () { return location.origin === P.origin && norm(location.pathname) === norm(P.path); };
var vis = function (el) {
  var r = el.getBoundingClientRect(); var cs = getComputedStyle(el);
  return r.width > 80 && r.height > 14 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly;
};
var editable = function (el) { return el.tagName === 'TEXTAREA' || el.isContentEditable; };
var findComposer = function () {
  var pref = document.querySelector('textarea[aria-label="消息输入"], textarea[aria-label="Message input"]');
  if (pref && !pref.disabled && !pref.readOnly) return pref;
  var list = Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')).filter(function (el) { return vis(el) && editable(el); });
  if (!list.length) return null;
  list.sort(function (a, b) { return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom; });
  return list[0];
};
var valueOf = function (el) { return (el.tagName === 'TEXTAREA' ? el.value : el.innerText) || ''; };
var stamped = function () { var el = document.querySelector('[data-hark-bridge-stamp="' + P.stamp + '"]'); return el && el.isConnected ? el : null; };
var same = function (el) { return valueOf(el).trim() === P.text.trim(); };
"#;

const INSPECT_JS: &str = r#"
if (!onTarget()) return JSON.stringify({ ok: false, wrongPage: true });
var el = findComposer();
if (!el) return JSON.stringify({ ok: false });
if (valueOf(el).trim()) return JSON.stringify({ ok: false, busy: true });
return JSON.stringify({ ok: true });
"#;

/// 填入：textarea 用原生 value setter + input 事件（React 受控组件才认），
/// contenteditable 把光标放到末尾后 insertText。
const FILL_JS: &str = r#"
if (!onTarget()) return JSON.stringify({ ok: false, code: 'wrong_page' });
var el = findComposer();
if (!el) return JSON.stringify({ ok: false, code: 'composer_missing' });
if (valueOf(el).trim()) return JSON.stringify({ ok: false, busy: true });
el.focus();
if (el.tagName === 'TEXTAREA') {
  var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  desc.set.call(el, P.text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
} else {
  var range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
  var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  if (!document.execCommand('insertText', false, P.text)) {
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: P.text }));
  }
}
el.setAttribute('data-hark-bridge-stamp', P.stamp);
if (!valueOf(el).trim()) return JSON.stringify({ ok: false, code: 'fill_rejected' });
return JSON.stringify({ ok: true });
"#;

/// 发送（= Hub 的 clickSendJS，先找 Hark 自己的发送按钮）。发送前核对输入框
/// 还是我们填的那段文字，被用户改过就不点。
const SEND_JS: &str = r#"
if (!onTarget()) return JSON.stringify({ ok: false, code: 'wrong_page' });
var el = stamped();
if (!el) return JSON.stringify({ ok: false, code: 'composer_gone' });
if (!same(el)) return JSON.stringify({ ok: false, code: 'draft_changed' });
var b = document.querySelector('button[data-composer-send="true"], button[aria-label="发送消息"], button[aria-label="Send message"]');
if (!b) {
  var root = el.closest('form') || (el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.parentElement) || document;
  var btns = Array.prototype.slice.call(root.querySelectorAll('button')).filter(function (x) { return !x.disabled; });
  b = btns.find(function (x) { return x.type === 'submit'; })
    || btns.find(function (x) { return /send|发送|submit/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + x.innerText); })
    || btns[btns.length - 1];
}
if (!b) return JSON.stringify({ ok: false, code: 'send_missing' });
if (b.disabled) return JSON.stringify({ ok: false, code: 'send_disabled' });
b.click();
return JSON.stringify({ ok: true });
"#;

/// 点完发送后输入框里是否还原样留着这段文字。
const LEFT_JS: &str = r#"
var el = stamped();
return JSON.stringify({ ok: true, same: !!(el && same(el)) });
"#;

/// = Hub 的 inPageJS：对话记录（不含输入框）里是否已经出现这个地址。
/// textarea 的内容不在 body.innerText 里；contenteditable 的要减掉。
const IN_PAGE_JS: &str = r#"
var c = findComposer();
var ct = c && c.tagName !== 'TEXTAREA' ? (c.innerText || '') : '';
var n = function (s) { return (s || '').split(P.marker).length - 1; };
return JSON.stringify(n(document.body ? document.body.innerText : '') - n(ct) > 0);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> Job {
        Job {
            origin: "https://hark.com".into(),
            path: "/project/abc".into(),
            text: "连接 \"x\"\n第二行 </script>".into(),
            marker: "https://bridge.example/mcp?k=1".into(),
            stamp: "s1".into(),
        }
    }

    #[test]
    fn only_https_hark_project_urls_are_accepted() {
        assert!(parse_project_url("https://hark.com/project/abc").is_ok());
        assert!(parse_project_url("https://www.hark.com/project/abc").is_ok());
        assert!(parse_project_url("http://hark.com/project/abc").is_err());
        assert!(parse_project_url("https://evilhark.com/project/abc").is_err());
    }

    #[test]
    fn target_match_ignores_trailing_slash_and_query() {
        let job = job();
        assert!(job.is_target_url("https://hark.com/project/abc/"));
        assert!(job.is_target_url("https://hark.com/project/abc?x=1#y"));
        assert!(!job.is_target_url("https://hark.com/project/abcd"));
        assert!(!job.is_target_url("https://www.hark.com/project/abc"));
    }

    #[test]
    fn scripts_embed_args_as_json_and_stay_one_expression() {
        let job = job();
        for action in [ACTION_INSPECT, ACTION_FILL, ACTION_SEND, ACTION_LEFT, ACTION_IN_PAGE] {
            let js = script(&job, action);
            assert!(js.starts_with("(function(){try{"));
            assert!(js.ends_with("}})()"));
            assert!(js.contains(&job.args()));
        }
        // 引号、换行都被转义，不会截断脚本
        assert!(job.args().contains("\\\"x\\\""));
        assert!(job.args().contains("\\n"));
    }
}
