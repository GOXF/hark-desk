//! Local, unauthenticated HTTP proxy that relays the embedded browser's
//! traffic to the configured upstream proxy.
//!
//! WebView2/Chromium cannot authenticate against a SOCKS5 proxy and only
//! prompts interactively for HTTP proxy credentials, so a proxy URL such as
//! `socks5://user:pass@host:port` cannot be handed to the webview directly.
//! When the configured proxy carries credentials we start a listener on
//! `127.0.0.1:<random port>` and point the webview at
//! `http://127.0.0.1:<port>`; this module then dials the real upstream with
//! the credentials.
//!
//! The upstream lives in a global `RwLock` and is re-read for every accepted
//! connection, so a change made in Settings → System → Network proxy takes
//! effect for new connections without restarting the webview environment.
//!
//! Credentials are never logged: only scheme/host/port of the upstream and the
//! target authority appear in tracing output.

use std::{
    net::SocketAddr,
    sync::{OnceLock, RwLock},
    time::Duration,
};

use base64::Engine as _;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const MAX_HEAD_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Environment keys written by the system proxy settings (see
/// `server::host::catalog::system::apply_proxy`).
pub const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

#[derive(Clone, PartialEq, Eq)]
pub enum UpstreamKind {
    Http,
    Socks5,
}

/// A parsed proxy URL. `Debug` is implemented by hand so the password can
/// never end up in a log line.
#[derive(Clone, PartialEq, Eq)]
pub struct ProxyEndpoint {
    pub kind: UpstreamKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxyEndpoint {
    pub fn has_credentials(&self) -> bool {
        self.username
            .as_deref()
            .is_some_and(|user| !user.is_empty())
    }

    /// `scheme://host:port` without credentials, safe to display or log.
    pub fn redacted(&self) -> String {
        let scheme = match self.kind {
            UpstreamKind::Http => "http",
            UpstreamKind::Socks5 => "socks5",
        };
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{scheme}://{host}:{}", self.port)
    }
}

impl std::fmt::Debug for ProxyEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyEndpoint")
            .field("url", &self.redacted())
            .field("authenticated", &self.has_credentials())
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Upstream {
    Direct,
    Proxy(ProxyEndpoint),
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            )
        {
            out.push((high * 16 + low) as u8);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse `scheme://[user[:pass]@]host:port[/...]`. Accepts `http`, `https`
/// (treated as a plain HTTP proxy), `socks5`, `socks5h` and `socks`. A URL
/// without a scheme is treated as HTTP.
pub fn parse_proxy_url(raw: &str) -> Option<ProxyEndpoint> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (kind, rest) = match trimmed.split_once("://") {
        Some((scheme, rest)) => {
            let kind = match scheme.to_ascii_lowercase().as_str() {
                "socks5" | "socks5h" | "socks" => UpstreamKind::Socks5,
                "http" | "https" => UpstreamKind::Http,
                _ => return None,
            };
            (kind, rest)
        }
        None => (UpstreamKind::Http, trimmed),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((userinfo, hostport)) => (Some(userinfo), hostport),
        None => (None, authority),
    };
    let (host, port) = if let Some(host) = hostport.strip_prefix('[') {
        let (addr, after) = host.split_once(']')?;
        (addr, after.strip_prefix(':')?)
    } else {
        hostport.rsplit_once(':')?
    };
    let port: u16 = port.parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    let (username, password) = match userinfo {
        Some(info) => {
            let (user, pass) = match info.split_once(':') {
                Some((user, pass)) => (user, Some(pass)),
                None => (info, None),
            };
            let user = percent_decode(user);
            if user.is_empty() {
                (None, None)
            } else {
                (Some(user), pass.map(percent_decode))
            }
        }
        None => (None, None),
    };
    Some(ProxyEndpoint {
        kind,
        host: host.to_owned(),
        port,
        username,
        password,
    })
}

/// First non-empty proxy URL from the process environment, raw (may contain
/// credentials — never log it).
pub fn env_proxy_raw() -> Option<String> {
    for key in PROXY_ENV_KEYS {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() && parse_proxy_url(value).is_some() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

/// Replace `user:pass@` in a proxy URL with `***@` for display.
pub fn redact_proxy_url(raw: &str) -> String {
    match parse_proxy_url(raw) {
        Some(endpoint) if endpoint.has_credentials() => {
            let redacted = endpoint.redacted();
            match redacted.split_once("://") {
                Some((scheme, rest)) => format!("{scheme}://***@{rest}"),
                None => redacted,
            }
        }
        _ => raw.to_owned(),
    }
}

fn upstream_slot() -> &'static RwLock<Upstream> {
    static SLOT: OnceLock<RwLock<Upstream>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(Upstream::Direct))
}

pub fn set_upstream(upstream: Upstream) {
    let mut slot = upstream_slot()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *slot != upstream {
        match &upstream {
            Upstream::Direct => tracing::info!("browser proxy forwarder upstream: direct"),
            Upstream::Proxy(endpoint) => tracing::info!(
                upstream = %endpoint.redacted(),
                authenticated = endpoint.has_credentials(),
                "browser proxy forwarder upstream updated"
            ),
        }
        *slot = upstream;
    }
}

/// Refresh the upstream from the process environment (the system proxy
/// settings write the env vars). No proxy configured → direct.
pub fn refresh_upstream_from_env() -> Upstream {
    let upstream = env_proxy_raw()
        .and_then(|raw| parse_proxy_url(&raw))
        .map(Upstream::Proxy)
        .unwrap_or(Upstream::Direct);
    set_upstream(upstream.clone());
    upstream
}

pub fn current_upstream() -> Upstream {
    upstream_slot()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Start (once) the local forwarder and return its listen address. The
/// listener runs on its own small tokio runtime thread so it can be started
/// from the UI thread synchronously.
pub fn ensure_started() -> std::io::Result<SocketAddr> {
    static ADDR: OnceLock<SocketAddr> = OnceLock::new();
    static START: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if let Some(addr) = ADDR.get() {
        return Ok(*addr);
    }
    let _guard = START
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(addr) = ADDR.get() {
        return Ok(*addr);
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("browser-proxy-fwd")
        .enable_all()
        .build()?;
    std::thread::Builder::new()
        .name("browser-proxy-forwarder".to_owned())
        .spawn(move || {
            runtime.block_on(async move {
                match TcpListener::from_std(listener) {
                    Ok(listener) => serve(listener, true).await,
                    Err(error) => {
                        tracing::error!(%error, "browser proxy forwarder failed to start");
                    }
                }
            });
        })?;
    tracing::info!(%addr, "browser proxy forwarder listening");
    let _ = ADDR.set(addr);
    Ok(addr)
}

/// Accept loop. When `refresh_from_env` is set every connection re-reads the
/// environment first so a settings change applies to the next connection.
pub async fn serve(listener: TcpListener, refresh_from_env: bool) {
    loop {
        let (client, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::debug!(%error, "browser proxy forwarder accept failed");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let upstream = if refresh_from_env {
            refresh_upstream_from_env()
        } else {
            current_upstream()
        };
        tokio::spawn(async move {
            if let Err(error) = handle_client(client, upstream).await {
                tracing::debug!(error = %error, "browser proxy forwarder connection ended");
            }
        });
    }
}

struct RequestHead {
    method: String,
    target: String,
    version: String,
    headers: Vec<(String, String)>,
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|pos| pos + 4)
}

/// Read until the end of the HTTP head. Returns the head bytes and any bytes
/// that were read past it.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "connection closed before request head",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_head_end(&buffer) {
            let rest = buffer.split_off(end);
            return Ok((buffer, rest));
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
    }
}

fn parse_request_head(head: &[u8]) -> Option<RequestHead> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let version = parts.next().unwrap_or("HTTP/1.1").to_owned();
    let headers = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_owned(), value.trim().to_owned()))
        })
        .collect();
    Some(RequestHead {
        method,
        target,
        version,
        headers,
    })
}

/// `host:port` → (host, port). IPv6 literals in brackets are unwrapped.
fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return Some((host.to_owned(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Some((host.to_owned(), port.parse().ok()?)),
        _ => Some((authority.to_owned(), default_port)),
    }
}

/// Split an absolute-form `http://host[:port]/path` into authority + path.
fn split_absolute_target(target: &str) -> Option<(String, u16, String)> {
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("HTTP://"))?;
    let (authority, path) = match rest.find(['/', '?']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = split_authority(authority, 80)?;
    let path = if path.starts_with('?') {
        format!("/{path}")
    } else {
        path.to_owned()
    };
    Some((host, port, path))
}

fn basic_auth(endpoint: &ProxyEndpoint) -> Option<String> {
    let user = endpoint
        .username
        .as_deref()
        .filter(|user| !user.is_empty())?;
    let pass = endpoint.password.as_deref().unwrap_or("");
    Some(base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}")))
}

fn is_hop_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("proxy-authorization")
        || name.eq_ignore_ascii_case("proxy-connection")
        || name.eq_ignore_ascii_case("connection")
        || name.eq_ignore_ascii_case("keep-alive")
}

trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

/// Open a TCP tunnel to `host:port` through the upstream (or directly).
async fn dial(upstream: &Upstream, host: &str, port: u16) -> std::io::Result<Box<dyn AsyncStream>> {
    let timed = |label: &'static str| {
        move |_| std::io::Error::new(std::io::ErrorKind::TimedOut, format!("{label} timed out"))
    };
    match upstream {
        Upstream::Direct => {
            let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
                .map_err(timed("direct connect"))??;
            let _ = stream.set_nodelay(true);
            Ok(Box::new(stream))
        }
        Upstream::Proxy(endpoint) => {
            let socket = tokio::time::timeout(
                CONNECT_TIMEOUT,
                TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
            )
            .await
            .map_err(timed("proxy connect"))??;
            let _ = socket.set_nodelay(true);
            match endpoint.kind {
                UpstreamKind::Socks5 => {
                    let handshake = async {
                        match (endpoint.username.as_deref(), endpoint.password.as_deref()) {
                            (Some(user), pass) if !user.is_empty() => {
                                tokio_socks::tcp::Socks5Stream::connect_with_password_and_socket(
                                    socket,
                                    (host, port),
                                    user,
                                    pass.unwrap_or(""),
                                )
                                .await
                            }
                            _ => {
                                tokio_socks::tcp::Socks5Stream::connect_with_socket(
                                    socket,
                                    (host, port),
                                )
                                .await
                            }
                        }
                    };
                    let stream = tokio::time::timeout(CONNECT_TIMEOUT, handshake)
                        .await
                        .map_err(timed("socks5 handshake"))?
                        .map_err(|error| {
                            std::io::Error::other(format!("socks5 upstream: {error}"))
                        })?;
                    Ok(Box::new(stream))
                }
                UpstreamKind::Http => {
                    let mut socket = socket;
                    let authority = if host.contains(':') {
                        format!("[{host}]:{port}")
                    } else {
                        format!("{host}:{port}")
                    };
                    let mut request =
                        format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
                    if let Some(token) = basic_auth(endpoint) {
                        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
                    }
                    request.push_str("\r\n");
                    socket.write_all(request.as_bytes()).await?;
                    let (head, rest) = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut socket))
                        .await
                        .map_err(timed("http proxy CONNECT"))??;
                    let status_line = std::str::from_utf8(&head)
                        .ok()
                        .and_then(|text| text.split("\r\n").next())
                        .unwrap_or("")
                        .to_owned();
                    let status = status_line
                        .split_whitespace()
                        .nth(1)
                        .and_then(|code| code.parse::<u16>().ok())
                        .unwrap_or(0);
                    if !(200..300).contains(&status) {
                        return Err(std::io::Error::other(format!(
                            "http upstream refused CONNECT: {status_line}"
                        )));
                    }
                    Ok(Box::new(Prefixed::new(rest, socket)))
                }
            }
        }
    }
}

async fn handle_client(mut client: TcpStream, upstream: Upstream) -> std::io::Result<()> {
    let _ = client.set_nodelay(true);
    let (head, rest) = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut client))
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "client head timed out")
        })??;
    let Some(request) = parse_request_head(&head) else {
        let _ = client
            .write_all(
                b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )
            .await;
        return Ok(());
    };

    if request.method.eq_ignore_ascii_case("CONNECT") {
        let Some((host, port)) = split_authority(&request.target, 443) else {
            let _ = client
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
            return Ok(());
        };
        let mut remote = match dial(&upstream, &host, port).await {
            Ok(remote) => remote,
            Err(error) => {
                tracing::debug!(target_host = %host, port, error = %error, "browser proxy forwarder CONNECT failed");
                let _ = client
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return Ok(());
            }
        };
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        if !rest.is_empty() {
            remote.write_all(&rest).await?;
        }
        let _ = tokio::io::copy_bidirectional(&mut client, &mut remote).await;
        return Ok(());
    }

    // Plain HTTP request in absolute form.
    let Some((host, port, path)) = split_absolute_target(&request.target) else {
        let _ = client
            .write_all(
                b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )
            .await;
        return Ok(());
    };
    let via_http_proxy =
        matches!(&upstream, Upstream::Proxy(endpoint) if endpoint.kind == UpstreamKind::Http);
    let mut remote: Box<dyn AsyncStream> = if via_http_proxy {
        let Upstream::Proxy(endpoint) = &upstream else {
            unreachable!()
        };
        match tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
        )
        .await
        {
            Ok(Ok(stream)) => Box::new(stream),
            _ => {
                let _ = client
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return Ok(());
            }
        }
    } else {
        match dial(&upstream, &host, port).await {
            Ok(remote) => remote,
            Err(error) => {
                tracing::debug!(target_host = %host, port, error = %error, "browser proxy forwarder HTTP dial failed");
                let _ = client
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return Ok(());
            }
        }
    };

    // Each forwarded request gets its own upstream connection (we force
    // `Connection: close`), so credentials injected here always apply and a
    // keep-alive connection can never leak to another host.
    let request_target = if via_http_proxy {
        request.target.clone()
    } else {
        path
    };
    let mut out = format!(
        "{} {} {}\r\n",
        request.method, request_target, request.version
    );
    for (name, value) in &request.headers {
        if is_hop_header(name) {
            continue;
        }
        out.push_str(name);
        out.push_str(": ");
        out.push_str(value);
        out.push_str("\r\n");
    }
    if via_http_proxy
        && let Upstream::Proxy(endpoint) = &upstream
        && let Some(token) = basic_auth(endpoint)
    {
        out.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    remote.write_all(out.as_bytes()).await?;
    if !rest.is_empty() {
        remote.write_all(&rest).await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut remote).await;
    Ok(())
}

/// A stream that yields `prefix` before reading from `inner` (bytes the HTTP
/// upstream sent right after its CONNECT response).
struct Prefixed<S> {
    prefix: Vec<u8>,
    offset: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            offset: 0,
            inner,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.offset < self.prefix.len() {
            let remaining = &self.prefix[self.offset..];
            let take = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..take]);
            self.offset += take;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_authenticated_socks_url() {
        let endpoint = parse_proxy_url("socks5://us%40er:p%3Ass@proxy.example:1080").unwrap();
        assert!(endpoint.kind == UpstreamKind::Socks5);
        assert_eq!(endpoint.host, "proxy.example");
        assert_eq!(endpoint.port, 1080);
        assert_eq!(endpoint.username.as_deref(), Some("us@er"));
        assert_eq!(endpoint.password.as_deref(), Some("p:ss"));
        assert!(endpoint.has_credentials());
        assert_eq!(endpoint.redacted(), "socks5://proxy.example:1080");
        assert!(!format!("{endpoint:?}").contains("p:ss"));
    }

    #[test]
    fn parses_plain_http_url() {
        let endpoint = parse_proxy_url("http://127.0.0.1:7890").unwrap();
        assert!(endpoint.kind == UpstreamKind::Http);
        assert!(!endpoint.has_credentials());
        let endpoint = parse_proxy_url("127.0.0.1:7890").unwrap();
        assert!(endpoint.kind == UpstreamKind::Http);
        assert!(parse_proxy_url("ftp://x:1").is_none());
        assert!(parse_proxy_url("http://host").is_none());
    }

    #[test]
    fn redacts_credentials() {
        assert_eq!(
            redact_proxy_url("socks5://u:secret@h:1080"),
            "socks5://***@h:1080"
        );
        assert_eq!(redact_proxy_url("http://h:8080"), "http://h:8080");
    }

    #[test]
    fn splits_absolute_targets() {
        assert_eq!(
            split_absolute_target("http://example.com/a?b").unwrap(),
            ("example.com".to_owned(), 80, "/a?b".to_owned())
        );
        assert_eq!(
            split_absolute_target("http://example.com:8080").unwrap(),
            ("example.com".to_owned(), 8080, "/".to_owned())
        );
        assert_eq!(
            split_authority("[::1]:443", 1).unwrap(),
            ("::1".to_owned(), 443)
        );
    }
}
