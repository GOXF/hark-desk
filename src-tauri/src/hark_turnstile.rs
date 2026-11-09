//! Narrow WebView2 input adapter for the account page's delayed widget click.

use serde::Deserialize;
use tauri_runtime_wry::wry::{WebView, WebViewExtWindows};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    WebMessageReceivedEventHandler, take_pwstr,
};
use windows::core::{HSTRING, PWSTR};

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClickRequest {
    #[serde(rename = "type")]
    _kind: RequestKind,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Deserialize)]
enum RequestKind {
    #[serde(rename = "hark-turnstile-click")]
    TurnstileClick,
}

fn parse_request(source: &str, message: &str) -> Option<ClickRequest> {
    let url = url::Url::parse(source).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https" || !(host == "hark.com" || host.ends_with(".hark.com")) {
        return None;
    }
    let point: ClickRequest = serde_json::from_str(message).ok()?;
    (point.x.is_finite()
        && point.y.is_finite()
        && (0.0..16384.0).contains(&point.x)
        && (0.0..16384.0).contains(&point.y))
    .then_some(point)
}

fn dispatch(
    view: ICoreWebView2,
    point: ClickRequest,
    source: String,
    step: usize,
) -> windows::core::Result<()> {
    let Some(event) = ["mouseMoved", "mousePressed", "mouseReleased"].get(step) else {
        return Ok(());
    };
    let mut current = PWSTR::null();
    unsafe { view.Source(&mut current)? };
    if take_pwstr(current) != source {
        return Ok(());
    }
    let params = serde_json::json!({
        "type": event,
        "x": point.x,
        "y": point.y,
        "button": if step == 0 { "none" } else { "left" },
        "buttons": if step == 1 { 1 } else { 0 },
        "clickCount": if step == 0 { 0 } else { 1 },
    });
    let next = view.clone();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, _| {
        status?;
        dispatch(next, point, source, step + 1)
    }));
    unsafe {
        view.CallDevToolsProtocolMethod(
            &HSTRING::from("Input.dispatchMouseEvent"),
            &HSTRING::from(params.to_string()),
            &handler,
        )
    }
}

pub(crate) fn install(view: &WebView) -> Result<(), String> {
    let handler = WebMessageReceivedEventHandler::create(Box::new(|view, args| {
        let (Some(view), Some(args)) = (view, args) else {
            return Ok(());
        };
        let mut source = PWSTR::null();
        let mut message = PWSTR::null();
        unsafe {
            args.Source(&mut source)?;
            args.WebMessageAsJson(&mut message)?;
        }
        let source = take_pwstr(source);
        let message = take_pwstr(message);
        if let Some(point) = parse_request(&source, &message) {
            dispatch(view, point, source, 0)?;
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe { view.webview().add_WebMessageReceived(&handler, &mut token) }
        .map_err(|error| format!("install Hark verification click handler: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE: &str = r#"{"type":"hark-turnstile-click","x":130,"y":232.5}"#;

    #[test]
    fn accepts_only_the_hark_click_request() {
        assert!(parse_request("https://hark.com/login", MESSAGE).is_some());
        assert!(parse_request("https://app.hark.com/login", MESSAGE).is_some());
        assert!(parse_request("http://hark.com/login", MESSAGE).is_none());
        assert!(parse_request("https://evilhark.com/login", MESSAGE).is_none());
        assert!(parse_request("https://hark.com.evil/login", MESSAGE).is_none());
        assert!(parse_request("https://challenges.cloudflare.com/", MESSAGE).is_none());
        assert!(
            parse_request("https://hark.com/login", r#"{"type":"other","x":1,"y":1}"#).is_none()
        );
    }

    #[test]
    fn rejects_invalid_coordinates_and_extra_commands() {
        for message in [
            r#"{"type":"hark-turnstile-click","x":-1,"y":1}"#,
            r#"{"type":"hark-turnstile-click","x":1,"y":16384}"#,
            r#"{"type":"hark-turnstile-click","x":1e999,"y":1}"#,
            r#"{"type":"hark-turnstile-click","x":1,"y":1,"script":"alert(1)"}"#,
        ] {
            assert!(parse_request("https://hark.com/login", message).is_none());
        }
    }
}
