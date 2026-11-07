//! Hark 本地文件桥（HarkBridge.exe）的后台管理：设置持久化、子进程启停与崩溃重启、
//! 解析 stdout 协议更新状态、通过事件把状态推给前端、地址就绪/变化时自动把连接消息发给绑定的账号。
//!
//! 结构（与 Hark Hub 的文件桥模块一致）：
//! - 主桥 id=main 必有，负责对外通道（ngrok / 自己的域名 / Cloudflare 临时通道）；
//! - 子桥默认 TUNNEL=none，经主桥按 routes.json 把 /mcp/<id> 转发过来；
//!   子桥设了 publicUrl 时用自己的地址（用户自己的反代指向这条桥的固定端口）；
//! - 「自己的域名」模式下主桥 TUNNEL=none，固定端口（默认 17890），地址 = customUrl/mcp。
//!
//! 日志绝不打印文件桥密钥和 ngrok authtoken。

pub mod commands;
pub mod logic;
pub mod secret;
pub mod settings;
pub mod types;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, watch};

use logic::{LineEvent, MAIN_ID, MODE_CUSTOM, MODE_NGROK};
use settings::{BridgeConf, SentRecord, Settings};
use types::{BindingState, BridgeState, ConfirmState, HarkBridgeState, TunnelState};

/// 状态变化事件名，载荷是完整的 [`HarkBridgeState`]。
pub const STATE_EVENT: &str = "hark-bridge://state";
/// 执行命令审批事件名，载荷是 [`ConfirmState`]（同时也在 state.confirms 里）。
pub const CONFIRM_EVENT: &str = "hark-bridge://confirm";

/// 文件桥程序在资源目录里的子目录（cloudflared 必须和它放在同一目录）。
const RESOURCE_SUBDIR: &str = "hark-bridge";
#[cfg(windows)]
const BRIDGE_EXE_NAME: &str = "HarkBridge.exe";
#[cfg(not(windows))]
const BRIDGE_EXE_NAME: &str = "HarkBridge";

/// 连续崩溃这么多次后停止自动重启。
const MAX_AUTO_RESTARTS: u32 = 8;
/// 稳定运行超过这个时长后再退出，重启计数清零。
const STABLE_RUN: Duration = Duration::from_secs(60);
/// 每条桥保留的日志行数。
const LOG_LINES: usize = 300;
/// 自动发送失败后的重试间隔与次数上限（同一账号同一地址）。
const SEND_RETRY_AFTER: Duration = Duration::from_secs(120);
const SEND_MAX_ATTEMPTS: u32 = 3;

static GENERATION: AtomicU64 = AtomicU64::new(1);
static MANAGER: OnceLock<Arc<BridgeManager>> = OnceLock::new();

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 正在运行的子进程句柄。丢弃或发送 kill 信号都会结束进程。
struct ProcHandle {
    pid: Option<u32>,
    kill_tx: Option<oneshot::Sender<()>>,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    /// 进程彻底退出后变为 true（重启前等旧进程释放端口）。
    done_rx: watch::Receiver<bool>,
}

impl ProcHandle {
    fn kill(mut self) -> watch::Receiver<bool> {
        if let Some(tx) = self.kill_tx.take() {
            let _ = tx.send(());
        }
        self.done_rx.clone()
    }
}

/// 一条桥的运行状态（只在内存里）。
struct Runtime {
    /// stopped / starting / running / no-tunnel / error
    status: String,
    port: u16,
    token: String,
    url: String,
    fixed: bool,
    tunnel: String,
    err: String,
    /// 固定根地址（custom 模式的主桥或设了 publicUrl 的子桥），非空时地址 = custom/mcp
    custom: String,
    /// 这条桥用到的 ngrok authtoken（只用于日志打码）
    ng_token: String,
    generation: u64,
    proc: Option<ProcHandle>,
    restarts: u32,
    running_since: Option<Instant>,
    log: VecDeque<String>,
    confirms: Vec<ConfirmState>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            status: "stopped".to_string(),
            port: 0,
            token: String::new(),
            url: String::new(),
            fixed: false,
            tunnel: String::new(),
            err: String::new(),
            custom: String::new(),
            ng_token: String::new(),
            generation: 0,
            proc: None,
            restarts: 0,
            running_since: None,
            log: VecDeque::new(),
            confirms: Vec::new(),
        }
    }
}

impl Runtime {
    fn push_log(&mut self, line: String) {
        self.log.push_back(line);
        while self.log.len() > LOG_LINES {
            self.log.pop_front();
        }
    }

    fn mark_running(&mut self) {
        if self.status != "running" {
            self.running_since = Some(Instant::now());
        }
        self.status = "running".to_string();
    }
}

struct SendFailure {
    url: String,
    attempts: u32,
    last: Instant,
    err: String,
}

struct Inner {
    settings: Settings,
    rt: HashMap<String, Runtime>,
    quitting: bool,
    /// 正在发送连接消息的账号
    sending: HashSet<String>,
    /// 自动发送失败记录（按账号）
    failures: HashMap<String, SendFailure>,
}

impl Inner {
    fn rt(&mut self, id: &str) -> &mut Runtime {
        self.rt.entry(id.to_string()).or_default()
    }

    fn rt_ref(&self, id: &str) -> Option<&Runtime> {
        self.rt.get(id)
    }

    /// 某条桥对外的地址（没上线返回空串）。
    fn bridge_url(&self, id: &str) -> String {
        let Some(st) = self.rt_ref(id) else {
            return String::new();
        };
        if id == MAIN_ID {
            return if st.status == "running" {
                st.url.clone()
            } else {
                String::new()
            };
        }
        if !st.custom.is_empty() {
            return if st.status == "running" {
                st.url.clone()
            } else {
                String::new()
            };
        }
        let main_url = self.bridge_url(MAIN_ID);
        logic::routed_url(id, &main_url, st.status == "running")
    }

    /// 某条桥的地址是否固定（重启不变）。
    fn bridge_fixed(&self, id: &str) -> bool {
        match self.rt_ref(id) {
            Some(st) if id != MAIN_ID && !st.custom.is_empty() => st.fixed,
            _ => self.rt_ref(MAIN_ID).map(|m| m.fixed).unwrap_or(false),
        }
    }

    /// 某条桥的连接消息；没上线或还不知道密钥时返回空串。
    fn message_for(&self, id: &str) -> String {
        let Some(conf) = self.settings.bridge(id) else {
            return String::new();
        };
        let url = self.bridge_url(id);
        if url.is_empty() {
            return String::new();
        }
        let token = self
            .rt_ref(id)
            .map(|st| st.token.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_default();
        if token.is_empty() {
            return String::new();
        }
        logic::connect_message(id, &conf.name, &url, self.bridge_fixed(id), &token)
    }

    fn snapshot(&self, exe_found: bool) -> HarkBridgeState {
        let s = &self.settings;
        let main_rt = self.rt_ref(MAIN_ID);
        let main_conf = s.bridge(MAIN_ID);
        let tunnel = TunnelState {
            mode: s.tunnel.mode.clone(),
            ngrok_domain: s.tunnel.ngrok_domain.clone(),
            has_ngrok_token: !s.tunnel.ngrok_token.is_empty(),
            custom_url: s.tunnel.custom_url.clone(),
            use_proxy: s.tunnel.use_proxy,
            status: main_rt
                .map(|r| r.status.clone())
                .unwrap_or_else(|| "stopped".to_string()),
            url: self.bridge_url(MAIN_ID),
            fixed: main_rt.map(|r| r.fixed).unwrap_or(false),
            port: main_rt
                .map(|r| r.port)
                .filter(|p| *p != 0)
                .or_else(|| main_conf.map(|b| b.port).filter(|p| *p != 0))
                .unwrap_or(0),
            err: main_rt.map(|r| r.err.clone()).unwrap_or_default(),
            tunnel: main_rt.map(|r| r.tunnel.clone()).unwrap_or_default(),
        };
        let bridges = s
            .bridges
            .iter()
            .map(|b| {
                let r = self.rt_ref(&b.id);
                let url = self.bridge_url(&b.id);
                BridgeState {
                    id: b.id.clone(),
                    name: b.name.clone(),
                    folder: b.folder.clone(),
                    readonly: b.readonly,
                    allow_delete: b.allow_delete,
                    exec_mode: b.exec_mode.clone(),
                    public_url: b.public_url.clone(),
                    status: r
                        .map(|r| r.status.clone())
                        .unwrap_or_else(|| "stopped".to_string()),
                    online: !url.is_empty() && r.map(|r| !r.token.is_empty()).unwrap_or(false),
                    url,
                    port: r
                        .map(|r| r.port)
                        .filter(|p| *p != 0)
                        .unwrap_or(b.port),
                    err: r.map(|r| r.err.clone()).unwrap_or_default(),
                    is_main: b.is_main(),
                    stopped: b.stopped,
                    fixed: self.bridge_fixed(&b.id),
                }
            })
            .collect();
        let bindings = s
            .bindings
            .iter()
            .map(|b| BindingState {
                profile_id: b.profile_id.clone(),
                bridge_id: b.bridge_id.clone(),
                project_url: b.project_url.clone(),
                sent_url: s.sent_for(&b.profile_id).map(|r| r.url.clone()),
                sending: self.sending.contains(&b.profile_id),
                send_err: self.failures.get(&b.profile_id).map(|f| f.err.clone()),
            })
            .collect();
        let confirms = s
            .bridges
            .iter()
            .filter_map(|b| self.rt_ref(&b.id))
            .flat_map(|r| r.confirms.iter().cloned())
            .collect();
        HarkBridgeState {
            tunnel,
            bridges,
            default_bridge: s.default_bridge.clone(),
            bindings,
            confirms,
            bridge_exe_found: exe_found,
        }
    }
}

/// 文件桥管理器（全局唯一）。
pub struct BridgeManager {
    app: AppHandle,
    /// app data 目录（hark-bridge.json 所在目录）
    data_dir: PathBuf,
    /// HarkBridge 程序路径
    exe: PathBuf,
    inner: Mutex<Inner>,
}

/// 应用启动时调用：读设置、建管理器、在后台启动所有该启动的桥。
pub fn init(app: &AppHandle) {
    if MANAGER.get().is_some() {
        return;
    }
    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            tracing::error!(%error, "文件桥：无法定位 app data 目录，模块未启用");
            return;
        }
    };
    let exe = locate_bridge_exe(app);
    let settings = Settings::load(&data_dir);
    let mgr = Arc::new(BridgeManager {
        app: app.clone(),
        data_dir,
        exe,
        inner: Mutex::new(Inner {
            settings,
            rt: HashMap::new(),
            quitting: false,
            sending: HashSet::new(),
            failures: HashMap::new(),
        }),
    });
    if MANAGER.set(mgr.clone()).is_err() {
        return;
    }
    tracing::info!(exe = %mgr.exe.display(), found = mgr.exe.is_file(), "文件桥模块已初始化");
    let ids: Vec<String> = {
        let inner = mgr.lock();
        inner
            .settings
            .bridges
            .iter()
            .filter(|b| !b.stopped && !b.folder.trim().is_empty())
            .map(|b| b.id.clone())
            .collect()
    };
    for id in ids {
        if let Err(error) = mgr.start(&id) {
            tracing::warn!(bridge = %id, %error, "文件桥自动启动失败");
        }
    }
    mgr.emit_state();
}

/// 取全局管理器。
pub fn manager() -> Result<Arc<BridgeManager>, String> {
    MANAGER
        .get()
        .cloned()
        .ok_or_else(|| "文件桥模块未初始化".to_string())
}

/// 应用退出时调用：结束所有文件桥子进程（同步，最多几秒）。
pub fn shutdown() {
    let Some(mgr) = MANAGER.get() else {
        return;
    };
    let procs: Vec<ProcHandle> = {
        let mut inner = mgr.lock();
        inner.quitting = true;
        inner
            .rt
            .values_mut()
            .filter_map(|st| {
                st.status = "stopped".to_string();
                st.url.clear();
                st.proc.take()
            })
            .collect()
    };
    for p in procs {
        if let Some(pid) = p.pid {
            kill_tree_blocking(pid);
        }
        let _ = p.kill();
    }
}

/// 资源目录里的 HarkBridge（可用 HARK_BRIDGE_EXE 覆盖，方便开发调试）。
fn locate_bridge_exe(app: &AppHandle) -> PathBuf {
    if let Some(p) = std::env::var_os("HARK_BRIDGE_EXE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
    }
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(RESOURCE_SUBDIR).join(BRIDGE_EXE_NAME));
        candidates.push(dir.join("resources").join(RESOURCE_SUBDIR).join(BRIDGE_EXE_NAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(RESOURCE_SUBDIR).join(BRIDGE_EXE_NAME));
        }
    }
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .or_else(|| candidates.first().cloned())
        .unwrap_or_else(|| PathBuf::from(BRIDGE_EXE_NAME))
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(0)
}

fn is_proxy_key(k: &str) -> bool {
    let up = k.to_ascii_uppercase();
    matches!(up.as_str(), "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY")
        || up.starts_with("HARK_BRIDGE_")
        || up.starts_with("NGROK_")
}

/// 当前进程的全局代理（system_settings 在启动时把它写进了进程环境变量）。
fn current_proxy() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty())
}

/// 结束进程树（Windows 用 taskkill /T /F；HarkBridge 自己也把 cloudflared/ngrok 放进了 Job，会一起结束）。
fn kill_tree_blocking(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

async fn kill_tree(pid: u32) {
    let _ = tokio::task::spawn_blocking(move || kill_tree_blocking(pid)).await;
}

/// 准备好的启动参数（在锁内算好，锁外启动进程）。
struct LaunchPlan {
    id: String,
    generation: u64,
    folder: String,
    env: Vec<(String, String)>,
    old_done: Option<watch::Receiver<bool>>,
}

impl BridgeManager {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn bridge_home(&self, id: &str) -> PathBuf {
        self.data_dir.join("hark-bridge").join(id)
    }

    fn routes_file(&self) -> PathBuf {
        self.data_dir.join("hark-bridge").join("routes.json")
    }

    fn exe_found(&self) -> bool {
        self.exe.is_file()
    }

    pub fn state(&self) -> HarkBridgeState {
        let exe_found = self.exe_found();
        self.lock().snapshot(exe_found)
    }

    /// 推送状态事件。
    pub fn emit_state(&self) {
        let state = self.state();
        if let Err(error) = self.app.emit(STATE_EVENT, state) {
            tracing::debug!(%error, "文件桥状态事件发送失败");
        }
    }

    fn save_locked(&self, inner: &Inner) {
        if let Err(error) = inner.settings.save(&self.data_dir) {
            tracing::warn!(%error, "保存文件桥设置失败");
        }
    }

    /// 写子桥路由表 {"id": 端口}（只写在运行的子桥）。持锁调用。
    fn write_routes_locked(&self, inner: &Inner) {
        let mut m = BTreeMap::new();
        for b in &inner.settings.bridges {
            if b.is_main() {
                continue;
            }
            if let Some(st) = inner.rt_ref(&b.id) {
                if st.status == "running" && st.port != 0 {
                    m.insert(b.id.clone(), st.port);
                }
            }
        }
        let f = self.routes_file();
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(error) = std::fs::write(&f, logic::routes_json(&m)) {
            tracing::warn!(%error, "写文件桥路由表失败");
        }
    }

    /// 把一条桥的进程摘下来（状态改成已停止），返回要等待退出的信号。持锁调用。
    fn detach_locked(&self, inner: &mut Inner, id: &str) -> Option<watch::Receiver<bool>> {
        let st = inner.rt(id);
        let proc = st.proc.take();
        st.status = "stopped".to_string();
        st.url.clear();
        st.running_since = None;
        st.confirms.clear();
        st.generation = GENERATION.fetch_add(1, Ordering::SeqCst);
        if id != MAIN_ID {
            self.write_routes_locked(inner);
        }
        proc.map(ProcHandle::kill)
    }

    /// （重新）启动一条桥。立即返回；进程在后台启动。
    pub fn start(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let plan = {
            let mut inner = self.lock();
            if inner.quitting {
                return Err("应用正在退出".to_string());
            }
            let Some(conf) = inner.settings.bridge(id).cloned() else {
                return Err(format!("找不到文件桥「{id}」"));
            };
            let old_done = self.detach_locked(&mut inner, id);
            if !self.exe.is_file() {
                let st = inner.rt(id);
                st.status = "error".to_string();
                st.err = format!("找不到文件桥程序：{}", self.exe.display());
                drop(inner);
                self.emit_state();
                return Err(format!("找不到文件桥程序：{}", self.exe.display()));
            }
            let folder = conf.folder.trim().to_string();
            if folder.is_empty() {
                let st = inner.rt(id);
                st.status = "stopped".to_string();
                st.err = "还没有选择共享文件夹，选好后会自动启动".to_string();
                drop(inner);
                self.emit_state();
                return Err("请先选择共享文件夹".to_string());
            }
            self.build_plan_locked(&mut inner, &conf, folder, old_done)
        };
        self.emit_state();
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            mgr.launch(plan).await;
        });
        Ok(())
    }

    /// 算好环境变量并把状态置为 starting。持锁调用。
    fn build_plan_locked(
        &self,
        inner: &mut Inner,
        conf: &BridgeConf,
        folder: String,
        old_done: Option<watch::Receiver<bool>>,
    ) -> LaunchPlan {
        let id = conf.id.clone();
        let tunnel_conf = inner.settings.tunnel.clone();
        let mut env: Vec<(String, String)> = vec![
            (
                "HARK_BRIDGE_HOME".into(),
                self.bridge_home(&id).to_string_lossy().into_owned(),
            ),
            ("HARK_BRIDGE_EMBEDDED".into(), "1".into()),
            (
                "HARK_BRIDGE_PARENT_PID".into(),
                std::process::id().to_string(),
            ),
            (
                "HARK_BRIDGE_EXEC_MODE".into(),
                logic::normalize_exec_mode(&conf.exec_mode),
            ),
            (
                "HARK_BRIDGE_ALLOW_DELETE".into(),
                if conf.allow_delete { "1" } else { "0" }.into(),
            ),
            (
                "HARK_BRIDGE_READONLY".into(),
                if conf.readonly { "1" } else { "0" }.into(),
            ),
        ];
        let mut ng_token = String::new();
        let mut custom = String::new();
        let mut note = String::new();
        if conf.is_main() {
            if tunnel_conf.use_proxy {
                if let Some(proxy) = current_proxy() {
                    env.push(("HTTPS_PROXY".into(), proxy.clone()));
                    env.push(("HTTP_PROXY".into(), proxy));
                }
            }
            env.push((
                "HARK_BRIDGE_ROUTES_FILE".into(),
                self.routes_file().to_string_lossy().into_owned(),
            ));
            self.write_routes_locked(inner);
            let mut tunnel = "cloudflare".to_string();
            match tunnel_conf.mode.as_str() {
                MODE_CUSTOM if !tunnel_conf.custom_url.is_empty() => {
                    tunnel = "none".to_string();
                    custom = tunnel_conf.custom_url.clone();
                    let port = if conf.port == 0 {
                        logic::DEFAULT_CUSTOM_PORT
                    } else {
                        conf.port
                    };
                    env.push(("HARK_BRIDGE_PORT".into(), port.to_string()));
                }
                MODE_CUSTOM => {
                    note = "已选「自己的域名」，但还没填地址，暂时用临时地址。".to_string();
                }
                MODE_NGROK if !tunnel_conf.ngrok_token.is_empty() => {
                    tunnel = "ngrok".to_string();
                    ng_token = tunnel_conf.ngrok_token.clone();
                    env.push(("HARK_BRIDGE_NGROK_AUTHTOKEN".into(), ng_token.clone()));
                    env.push((
                        "HARK_BRIDGE_NGROK_DOMAIN".into(),
                        logic::clean_domain(&tunnel_conf.ngrok_domain),
                    ));
                }
                MODE_NGROK => {
                    note = "已选固定地址（ngrok），但还没填 authtoken，暂时用临时地址。".to_string();
                }
                _ => {}
            }
            env.push(("HARK_BRIDGE_TUNNEL".into(), tunnel));
        } else {
            if !conf.public_url.is_empty() {
                custom = conf.public_url.clone();
            }
            env.push(("HARK_BRIDGE_TUNNEL".into(), "none".into()));
            let mut port = conf.port;
            if port == 0 {
                port = free_port();
                if port != 0 {
                    if let Some(b) = inner.settings.bridge_mut(&id) {
                        b.port = port;
                    }
                    self.save_locked(inner);
                }
            }
            if port != 0 {
                env.push(("HARK_BRIDGE_PORT".into(), port.to_string()));
            }
        }
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
        let st = inner.rt(&id);
        let restarts = st.restarts;
        let log = std::mem::take(&mut st.log);
        *st = Runtime {
            status: "starting".to_string(),
            custom,
            ng_token,
            generation,
            restarts,
            err: note,
            log,
            ..Runtime::default()
        };
        LaunchPlan {
            id,
            generation,
            folder,
            env,
            old_done,
        }
    }

    /// 后台：等旧进程退出，启动新进程，接上输出和退出处理。
    async fn launch(self: Arc<Self>, plan: LaunchPlan) {
        if let Some(mut rx) = plan.old_done {
            let _ = tokio::time::timeout(Duration::from_secs(6), rx.wait_for(|done| *done)).await;
        }
        // 等待期间可能又被停止/重启了
        {
            let inner = self.lock();
            let current = inner
                .rt_ref(&plan.id)
                .map(|st| st.generation == plan.generation)
                .unwrap_or(false);
            if !current || inner.quitting {
                return;
            }
        }
        let mut cmd = Command::new(&self.exe);
        cmd.arg(&plan.folder)
            .env_clear()
            .envs(std::env::vars_os().filter(|(k, _)| !is_proxy_key(&k.to_string_lossy())))
            .envs(plan.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = self.exe.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child: Child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                {
                    let mut inner = self.lock();
                    let st = inner.rt(&plan.id);
                    if st.generation == plan.generation {
                        st.status = "error".to_string();
                        st.err = format!("文件桥启动失败：{error}");
                    }
                }
                tracing::warn!(bridge = %plan.id, %error, "文件桥启动失败");
                self.emit_state();
                return;
            }
        };
        let pid = child.id();
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = watch::channel(false);
        let attached = {
            let mut inner = self.lock();
            let quitting = inner.quitting;
            let st = inner.rt(&plan.id);
            if st.generation == plan.generation && !quitting {
                st.proc = Some(ProcHandle {
                    pid,
                    kill_tx: Some(kill_tx),
                    stdin,
                    done_rx,
                });
                true
            } else {
                false
            }
        };
        if !attached {
            if let Some(pid) = pid {
                kill_tree(pid).await;
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            return;
        }
        tracing::info!(bridge = %plan.id, pid = ?pid, "文件桥已启动");
        if let Some(out) = stdout {
            let mgr = self.clone();
            let id = plan.id.clone();
            tauri::async_runtime::spawn(async move {
                mgr.pump_lines(out, id, plan.generation).await;
            });
        }
        if let Some(err) = stderr {
            let mgr = self.clone();
            let id = plan.id.clone();
            tauri::async_runtime::spawn(async move {
                mgr.pump_lines(err, id, plan.generation).await;
            });
        }
        self.supervise(plan.id, plan.generation, child, kill_rx, done_tx)
            .await;
    }

    /// 逐行读输出（容忍非 UTF-8）。
    async fn pump_lines<R: AsyncRead + Unpin>(self: Arc<Self>, reader: R, id: String, generation: u64) {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::with_capacity(512);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let line = line.trim_end_matches(['\r', '\n']);
                    self.on_line(&id, generation, line);
                }
            }
        }
    }

    /// 等进程退出或收到结束信号。
    async fn supervise(
        self: Arc<Self>,
        id: String,
        generation: u64,
        mut child: Child,
        mut kill_rx: oneshot::Receiver<()>,
        done_tx: watch::Sender<bool>,
    ) {
        enum Outcome {
            Exited(Option<i32>),
            Kill,
        }
        let pid = child.id();
        let outcome = tokio::select! {
            status = child.wait() => Outcome::Exited(status.ok().and_then(|s| s.code())),
            _ = &mut kill_rx => Outcome::Kill,
        };
        match outcome {
            Outcome::Kill => {
                if let Some(pid) = pid {
                    kill_tree(pid).await;
                }
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                let _ = done_tx.send(true);
                tracing::info!(bridge = %id, "文件桥已停止");
            }
            Outcome::Exited(code) => {
                let _ = done_tx.send(true);
                self.on_exit(&id, generation, code);
            }
        }
    }

    /// 处理 HarkBridge 输出的一行。
    fn on_line(self: &Arc<Self>, id: &str, generation: u64, line: &str) {
        let mut confirm_event: Option<ConfirmState> = None;
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let custom_port_conf = inner
                .settings
                .bridge(id)
                .map(|b| b.port)
                .unwrap_or(0);
            let st = inner.rt(id);
            if st.generation != generation || st.proc.is_none() {
                return;
            }
            let ng = st.ng_token.clone();
            let tok = st.token.clone();
            if let Some(l) = logic::redact_line(line, &[ng.as_str(), tok.as_str()]) {
                if !l.trim().is_empty() {
                    st.push_log(l);
                }
            }
            let mut routes_dirty = false;
            let mut save_port: Option<u16> = None;
            match logic::parse_line(line) {
                LineEvent::None => {}
                LineEvent::Url(mut value) => {
                    if !st.custom.is_empty() {
                        // 用户自己的地址：固定，由用户的服务器反代到本机端口
                        value = format!("{}/mcp", st.custom);
                        st.fixed = true;
                        st.tunnel = "custom".to_string();
                    }
                    if id == MAIN_ID || !st.custom.is_empty() {
                        st.url = value;
                        if st.url.is_empty() {
                            st.status = "no-tunnel".to_string();
                            st.running_since = None;
                            if !st.err.is_empty() {
                                st.err.push(' ');
                            }
                            st.err.push_str("加密通道没有建立（连不上 Cloudflare / ngrok）。");
                        } else {
                            st.mark_running();
                        }
                    } else {
                        st.mark_running();
                    }
                    routes_dirty = id != MAIN_ID;
                }
                LineEvent::Port(n) => {
                    st.port = n;
                    if id != MAIN_ID {
                        save_port = Some(n);
                    } else if !st.custom.is_empty() {
                        let want = if custom_port_conf == 0 {
                            logic::DEFAULT_CUSTOM_PORT
                        } else {
                            custom_port_conf
                        };
                        if want != n {
                            st.err = format!(
                                "端口 {want} 被占用，文件桥改用了 {n}；请把你的反代改到 {n}，或释放 {want} 后重启文件桥。"
                            );
                        }
                    }
                    routes_dirty = id != MAIN_ID && st.status == "running";
                }
                LineEvent::Fixed(f) => {
                    st.fixed = f || !st.custom.is_empty();
                }
                LineEvent::Tunnel(t) => {
                    if t == "cloudflare-fallback" {
                        st.err = "ngrok 没连上，已暂时改用临时地址（会变）。".to_string();
                    }
                    st.tunnel = t;
                }
                LineEvent::Token(t) => {
                    st.token = t;
                }
                LineEvent::Folder(_) => {}
                LineEvent::Confirm {
                    req_id,
                    payload_b64,
                } => {
                    let payload = logic::decode_confirm(&payload_b64);
                    let c = ConfirmState {
                        bridge_id: id.to_string(),
                        req_id,
                        kind: payload.kind,
                        command: payload.command,
                        cwd: payload.cwd,
                    };
                    st.confirms.retain(|x| x.req_id != c.req_id);
                    st.confirms.push(c.clone());
                    confirm_event = Some(c);
                }
                LineEvent::Error(e) => {
                    st.err = e;
                }
            }
            if let Some(n) = save_port {
                let changed = match inner.settings.bridge_mut(id) {
                    Some(b) if b.port != n => {
                        b.port = n;
                        true
                    }
                    _ => false,
                };
                if changed {
                    self.save_locked(inner);
                }
            }
            if routes_dirty {
                self.write_routes_locked(inner);
            }
        }
        if let Some(c) = confirm_event {
            let _ = self.app.emit(CONFIRM_EVENT, c.clone());
            // 120 秒后 HarkBridge 自己按超时拒绝，这里顺手清掉
            let mgr = self.clone();
            let id = id.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(125)).await;
                let removed = {
                    let mut inner = mgr.lock();
                    let st = inner.rt(&id);
                    let before = st.confirms.len();
                    st.confirms.retain(|x| x.req_id != c.req_id);
                    before != st.confirms.len()
                };
                if removed {
                    mgr.emit_state();
                }
            });
        }
        // 只在协议行上推送状态，普通日志不推
        if logic::parse_line(line) != LineEvent::None {
            self.emit_state();
            self.autosend_check();
        }
    }

    /// 进程自己退出了（崩溃或出错）：标记状态，按退避自动重启。
    fn on_exit(self: &Arc<Self>, id: &str, generation: u64, code: Option<i32>) {
        let restart_in: Option<(u64, u64)> = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            let quitting = inner.quitting;
            let user_stopped = inner.settings.bridge(id).map(|b| b.stopped).unwrap_or(true);
            let st = inner.rt(id);
            if st.generation != generation || st.proc.is_none() {
                return;
            }
            st.proc = None;
            st.url.clear();
            st.confirms.clear();
            if st
                .running_since
                .map(|t| t.elapsed() >= STABLE_RUN)
                .unwrap_or(false)
            {
                st.restarts = 0;
            }
            st.running_since = None;
            let code_text = code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "未知".to_string());
            let plan = if quitting {
                st.status = "stopped".to_string();
                None
            } else {
                st.status = "error".to_string();
                if st.err.is_empty() {
                    st.err = format!("文件桥已退出（代码 {code_text}）");
                }
                if user_stopped {
                    None
                } else if st.restarts >= MAX_AUTO_RESTARTS {
                    st.err.push_str(" 多次重启都失败了，已停止自动重启，请检查后手动启动。");
                    None
                } else {
                    st.restarts += 1;
                    let secs = logic::backoff_secs(st.restarts);
                    st.err.push_str(&format!(" {secs} 秒后自动重启。"));
                    Some((secs, st.generation))
                }
            };
            if id != MAIN_ID {
                self.write_routes_locked(inner);
            }
            plan
        };
        tracing::warn!(bridge = %id, code = ?code, "文件桥进程已退出");
        self.emit_state();
        if let Some((secs, generation)) = restart_in {
            let mgr = self.clone();
            let id = id.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(secs)).await;
                let still = {
                    let inner = mgr.lock();
                    !inner.quitting
                        && inner
                            .settings
                            .bridge(&id)
                            .map(|b| !b.stopped)
                            .unwrap_or(false)
                        && inner
                            .rt_ref(&id)
                            .map(|st| st.generation == generation && st.proc.is_none())
                            .unwrap_or(false)
                };
                if still {
                    if let Err(error) = mgr.start(&id) {
                        tracing::warn!(bridge = %id, %error, "文件桥自动重启失败");
                    }
                }
            });
        }
    }

    /// 停止一条桥（用户操作）：记住「已停止」，启动应用时不再自动启动。
    pub fn stop(self: &Arc<Self>, id: &str) -> Result<(), String> {
        {
            let mut inner = self.lock();
            let Some(b) = inner.settings.bridge_mut(id) else {
                return Err(format!("找不到文件桥「{id}」"));
            };
            b.stopped = true;
            self.save_locked(&inner);
            let _ = self.detach_locked(&mut inner, id);
            let st = inner.rt(id);
            st.err.clear();
            st.restarts = 0;
        }
        self.emit_state();
        self.autosend_check();
        Ok(())
    }

    /// 用户手动启动：清掉「已停止」和重启计数。
    pub fn start_by_user(self: &Arc<Self>, id: &str) -> Result<(), String> {
        {
            let mut inner = self.lock();
            let Some(b) = inner.settings.bridge_mut(id) else {
                return Err(format!("找不到文件桥「{id}」"));
            };
            b.stopped = false;
            self.save_locked(&inner);
            inner.rt(id).restarts = 0;
        }
        self.start(id)
    }

    /// 往桥的 stdin 写一行（审批回复 / 切换执行模式）。
    async fn write_stdin(&self, id: &str, line: String) -> Result<(), String> {
        let stdin = {
            let inner = self.lock();
            inner
                .rt_ref(id)
                .and_then(|st| st.proc.as_ref())
                .map(|p| p.stdin.clone())
        };
        let Some(stdin) = stdin else {
            return Err("文件桥没有在运行".to_string());
        };
        let mut guard = stdin.lock().await;
        let Some(pipe) = guard.as_mut() else {
            return Err("文件桥的输入已关闭".to_string());
        };
        pipe.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写入文件桥失败：{e}"))?;
        pipe.flush().await.map_err(|e| format!("写入文件桥失败：{e}"))?;
        Ok(())
    }

    /// 修改执行命令模式：持久化并通知运行中的桥（不重启）。
    pub async fn set_exec_mode(self: &Arc<Self>, id: &str, mode: &str) -> Result<(), String> {
        let mode = logic::normalize_exec_mode(mode);
        let running = {
            let mut inner = self.lock();
            let Some(b) = inner.settings.bridge_mut(id) else {
                return Err(format!("找不到文件桥「{id}」"));
            };
            b.exec_mode = mode.clone();
            self.save_locked(&inner);
            inner
                .rt_ref(id)
                .map(|st| st.proc.is_some())
                .unwrap_or(false)
        };
        if running {
            self.write_stdin(id, format!("EXECMODE {mode}\n")).await?;
        }
        self.emit_state();
        Ok(())
    }

    /// 回复执行命令审批。answer：allow（这一次）/ always（一直允许，执行模式改为 auto）/
    /// deny（这一次拒绝）/ never（拒绝并关闭命令执行，执行模式改为 off）。
    pub async fn answer_confirm(
        self: &Arc<Self>,
        bridge_id: &str,
        req_id: &str,
        answer: &str,
    ) -> Result<(), String> {
        let (wire, new_mode) = match answer {
            "allow" => ("allow", None),
            "always" => ("always", Some("auto")),
            "deny" => ("deny", None),
            "never" => ("deny", Some("off")),
            _ => return Err("answer 只能是 allow / always / deny / never".to_string()),
        };
        if req_id.is_empty() || req_id.contains(char::is_whitespace) {
            return Err("请求 id 不合法".to_string());
        }
        {
            let mut inner = self.lock();
            inner.rt(bridge_id).confirms.retain(|c| c.req_id != req_id);
        }
        let result = self
            .write_stdin(bridge_id, format!("CONFIRM {req_id} {wire}\n"))
            .await;
        if let Some(mode) = new_mode {
            self.set_exec_mode(bridge_id, mode).await?;
        } else {
            self.emit_state();
        }
        result
    }

    pub fn logs(&self, id: &str) -> Vec<String> {
        self.lock()
            .rt_ref(id)
            .map(|st| st.log.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 某条桥的连接消息（与 Hub 一致）。没上线返回 Err。
    pub fn connect_message(&self, bridge_id: &str) -> Result<String, String> {
        let inner = self.lock();
        if inner.settings.bridge(bridge_id).is_none() {
            return Err(format!("找不到文件桥「{bridge_id}」"));
        }
        let msg = inner.message_for(bridge_id);
        if msg.is_empty() {
            return Err("文件桥还没上线".to_string());
        }
        Ok(msg)
    }

    // ---------- 自动发送 ----------

    /// 对每个绑定检查：桥在线、地址（或项目链接）和上次成功发送的不同 → 调 inject 发送。
    pub fn autosend_check(self: &Arc<Self>) {
        struct Job {
            profile_id: String,
            project_url: String,
            url: String,
            text: String,
        }
        let jobs: Vec<Job> = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            if inner.quitting {
                return;
            }
            let mut jobs = Vec::new();
            for b in inner.settings.bindings.clone() {
                let url = inner.bridge_url(&b.bridge_id);
                if url.is_empty() {
                    continue;
                }
                if let Some(sent) = inner.settings.sent_for(&b.profile_id) {
                    if sent.url == url && sent.project_url == b.project_url {
                        continue;
                    }
                }
                if inner.sending.contains(&b.profile_id) {
                    continue;
                }
                if let Some(f) = inner.failures.get(&b.profile_id) {
                    if f.url == url
                        && (f.attempts >= SEND_MAX_ATTEMPTS || f.last.elapsed() < SEND_RETRY_AFTER)
                    {
                        continue;
                    }
                }
                let text = inner.message_for(&b.bridge_id);
                if text.is_empty() {
                    continue;
                }
                inner.sending.insert(b.profile_id.clone());
                jobs.push(Job {
                    profile_id: b.profile_id,
                    project_url: b.project_url,
                    url,
                    text,
                });
            }
            jobs
        };
        if jobs.is_empty() {
            return;
        }
        self.emit_state();
        for job in jobs {
            let mgr = self.clone();
            tauri::async_runtime::spawn(async move {
                tracing::info!(profile = %job.profile_id, "文件桥：自动发送连接消息");
                let result = crate::hark_bridge_inject::send_connect_message(
                    &mgr.app,
                    &job.profile_id,
                    &job.project_url,
                    &job.text,
                    &job.url,
                )
                .await;
                mgr.finish_send(&job.profile_id, &job.url, &job.project_url, result, true);
            });
        }
    }

    fn finish_send(
        self: &Arc<Self>,
        profile_id: &str,
        url: &str,
        project_url: &str,
        result: Result<(), String>,
        automatic: bool,
    ) {
        let retry = {
            let mut inner = self.lock();
            inner.sending.remove(profile_id);
            match &result {
                Ok(()) => {
                    inner.failures.remove(profile_id);
                    inner.settings.set_sent(SentRecord {
                        profile_id: profile_id.to_string(),
                        url: url.to_string(),
                        project_url: project_url.to_string(),
                    });
                    self.save_locked(&inner);
                    false
                }
                Err(err) => {
                    let entry = inner
                        .failures
                        .entry(profile_id.to_string())
                        .or_insert_with(|| SendFailure {
                            url: url.to_string(),
                            attempts: 0,
                            last: Instant::now(),
                            err: String::new(),
                        });
                    if entry.url != url {
                        entry.url = url.to_string();
                        entry.attempts = 0;
                    }
                    if automatic {
                        entry.attempts += 1;
                    }
                    entry.last = Instant::now();
                    entry.err = err.clone();
                    automatic && entry.attempts < SEND_MAX_ATTEMPTS
                }
            }
        };
        match &result {
            Ok(()) => tracing::info!(profile = %profile_id, "文件桥：连接消息已发送"),
            Err(err) => tracing::warn!(profile = %profile_id, error = %err, "文件桥：连接消息发送失败"),
        }
        self.emit_state();
        if retry {
            let mgr = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SEND_RETRY_AFTER + Duration::from_secs(1)).await;
                mgr.autosend_check();
            });
        }
    }

    /// 手动发送（hark_bridge_send）：发给这个账号绑定的桥；没绑定时用默认桥、发到当前聊天（projectUrl 为空）。
    pub async fn send_now(self: &Arc<Self>, profile_id: &str) -> Result<(), String> {
        let (url, project_url, text) = {
            let mut inner = self.lock();
            let (bridge_id, project_url) = match inner.settings.binding(profile_id) {
                Some(b) => (b.bridge_id.clone(), b.project_url.clone()),
                None => (inner.settings.default_bridge.clone(), String::new()),
            };
            let url = inner.bridge_url(&bridge_id);
            let text = inner.message_for(&bridge_id);
            if url.is_empty() || text.is_empty() {
                return Err("文件桥还没上线".to_string());
            }
            if !inner.sending.insert(profile_id.to_string()) {
                return Err("正在发送，请稍候".to_string());
            }
            (url, project_url, text)
        };
        self.emit_state();
        let result = crate::hark_bridge_inject::send_connect_message(
            &self.app,
            profile_id,
            &project_url,
            &text,
            &url,
        )
        .await;
        self.finish_send(profile_id, &url, &project_url, result.clone(), false);
        result
    }

    // ---------- 设置修改 ----------

    /// 清掉某个账号的自动发送失败记录（重新绑定后允许立即重试）。
    pub fn forget_failure(&self, profile_id: &str) {
        self.lock().failures.remove(profile_id);
    }

    /// 在锁内修改设置并保存；返回闭包的结果。
    fn with_settings<T>(&self, f: impl FnOnce(&mut Settings) -> Result<T, String>) -> Result<T, String> {
        let mut inner = self.lock();
        let out = f(&mut inner.settings)?;
        inner.settings.normalize();
        self.save_locked(&inner);
        Ok(out)
    }

    /// 主桥当前是否应当运行（有共享文件夹且没被用户停止）。
    fn main_should_run(&self) -> bool {
        let inner = self.lock();
        inner
            .settings
            .bridge(MAIN_ID)
            .map(|b| !b.stopped && !b.folder.trim().is_empty())
            .unwrap_or(false)
    }

    fn should_run(&self, id: &str) -> bool {
        let inner = self.lock();
        inner
            .settings
            .bridge(id)
            .map(|b| !b.stopped && !b.folder.trim().is_empty())
            .unwrap_or(false)
    }

    /// 删掉一条子桥：停进程、删设置，用它的账号改回默认桥。
    pub fn delete(self: &Arc<Self>, id: &str) -> Result<(), String> {
        if id == MAIN_ID {
            return Err("主文件桥不能删除".to_string());
        }
        {
            let mut inner = self.lock();
            if inner.settings.bridge(id).is_none() {
                return Err(format!("找不到文件桥「{id}」"));
            }
            let _ = self.detach_locked(&mut inner, id);
            inner.settings.bridges.retain(|b| b.id != id);
            if inner.settings.default_bridge == id {
                inner.settings.default_bridge = MAIN_ID.to_string();
            }
            let default_bridge = inner.settings.default_bridge.clone();
            for b in &mut inner.settings.bindings {
                if b.bridge_id == id {
                    b.bridge_id = default_bridge.clone();
                }
            }
            inner.rt.remove(id);
            inner.settings.normalize();
            self.save_locked(&inner);
            self.write_routes_locked(&inner);
        }
        self.emit_state();
        self.autosend_check();
        Ok(())
    }
}

/// 测试辅助：在不启动 Tauri 的情况下检查地址推导。
#[cfg(test)]
mod tests {
    use super::*;

    fn inner_with(settings: Settings) -> Inner {
        Inner {
            settings,
            rt: HashMap::new(),
            quitting: false,
            sending: HashSet::new(),
            failures: HashMap::new(),
        }
    }

    #[test]
    fn urls_follow_main_and_custom() {
        let mut s = Settings::default();
        s.bridges.push(BridgeConf {
            id: "docs".into(),
            name: "文档".into(),
            folder: "C:/d".into(),
            readonly: false,
            allow_delete: false,
            exec_mode: "off".into(),
            public_url: String::new(),
            port: 0,
            stopped: false,
        });
        let mut inner = inner_with(s);
        assert_eq!(inner.bridge_url("main"), "");
        {
            let m = inner.rt("main");
            m.status = "running".into();
            m.url = "https://a.trycloudflare.com/mcp".into();
            m.token = "hark_x".into();
        }
        assert_eq!(inner.bridge_url("main"), "https://a.trycloudflare.com/mcp");
        assert_eq!(inner.bridge_url("docs"), "");
        {
            let d = inner.rt("docs");
            d.status = "running".into();
            d.token = "hark_d".into();
        }
        assert_eq!(
            inner.bridge_url("docs"),
            "https://a.trycloudflare.com/mcp/docs"
        );
        assert!(inner.message_for("docs").contains("MCP 名称 hark-files-docs"));
        assert!(inner.message_for("docs").contains("密钥：hark_d"));
        {
            let d = inner.rt("docs");
            d.custom = "https://docs.example.com".into();
            d.url = "https://docs.example.com/mcp".into();
            d.fixed = true;
        }
        assert_eq!(inner.bridge_url("docs"), "https://docs.example.com/mcp");
        assert!(inner.bridge_fixed("docs"));
    }
}
