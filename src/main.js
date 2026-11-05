import { invoke } from "@tauri-apps/api/core";

const HOME = "https://hark.com/";
const COLORS = ["#2f6bff", "#14a37f", "#e2683c", "#8b5cf6", "#d93f87", "#0e9ab8", "#c99a06", "#555"];
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);

// state: { accounts: [{id,name,color,projects:[{id,name,collapsed,items:[{id,title,url}]}]}], current, settings:{css} }
let state = { accounts: [], current: null, settings: { css: "" } };
let activeConv = null;

async function save() {
  await invoke("save_state", { state: JSON.stringify(state) });
}
const acct = () => state.accounts.find((a) => a.id === state.current);

/* ---------- 右侧区域位置同步给原生 WebView ---------- */
function paneRect() {
  const r = $("#pane").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
async function syncPane() {
  await invoke("set_pane", paneRect());
}
new ResizeObserver(() => syncPane()).observe($("#pane"));

/* ---------- 对话框（打开时先藏起 Hark 页面，免得被盖住） ---------- */
async function dialog(title, fields) {
  await invoke("hide_all");
  $("#dlg-title").textContent = title;
  const body = $("#dlg-body");
  body.innerHTML = "";
  for (const f of fields) {
    const l = document.createElement("label");
    l.textContent = f.label;
    const el = document.createElement(f.textarea ? "textarea" : "input");
    el.name = f.name;
    el.value = f.value ?? "";
    if (f.placeholder) el.placeholder = f.placeholder;
    body.append(l, el);
  }
  const dlg = $("#dlg");
  dlg.showModal();
  body.querySelector("input,textarea")?.focus();
  const res = await new Promise((ok) => dlg.addEventListener("close", () => ok(dlg.returnValue), { once: true }));
  const out = res === "ok" ? Object.fromEntries(fields.map((f) => [f.name, body.querySelector(`[name="${f.name}"]`).value])) : null;
  if (state.current) await invoke("show_account", { id: state.current, url: null, css: state.settings.css });
  return out;
}

/* ---------- 账号 ---------- */
async function addAccount() {
  const r = await dialog("添加账号", [{ name: "name", label: "名称（只用来区分）", placeholder: "比如：主号" }]);
  if (!r || !r.name.trim()) return;
  const a = {
    id: uid(),
    name: r.name.trim(),
    color: COLORS[state.accounts.length % COLORS.length],
    projects: [{ id: uid(), name: "默认", collapsed: false, items: [] }],
  };
  state.accounts.push(a);
  await save();
  await selectAccount(a.id);
}

async function selectAccount(id) {
  state.current = id;
  activeConv = null;
  await save();
  render();
  await syncPane();
  // 每个账号一个独立数据目录 → 登录各自保持，互不干扰
  await invoke("show_account", { id, url: null, css: state.settings.css });
}

async function accountMenu(a, ev) {
  ev.preventDefault();
  const r = await dialog(`账号：${a.name}`, [
    { name: "name", label: "名称", value: a.name },
    { name: "del", label: "输入 删除 可移除这个账号（会清掉它的登录数据）", placeholder: "" },
  ]);
  if (!r) return;
  if (r.del.trim() === "删除") {
    await invoke("remove_account", { id: a.id });
    state.accounts = state.accounts.filter((x) => x.id !== a.id);
    if (state.current === a.id) state.current = state.accounts[0]?.id ?? null;
    await save();
    render();
    if (state.current) await selectAccount(state.current);
    return;
  }
  a.name = r.name.trim() || a.name;
  await save();
  render();
}

/* ---------- 项目 / 对话 ---------- */
async function addProject() {
  const a = acct();
  if (!a) return;
  const r = await dialog("新建项目", [{ name: "name", label: "项目名" }]);
  if (!r || !r.name.trim()) return;
  a.projects.push({ id: uid(), name: r.name.trim(), collapsed: false, items: [] });
  await save();
  render();
}

async function pinCurrent() {
  const a = acct();
  if (!a) return;
  const page = await invoke("current_page", { id: a.id });
  const r = await dialog("收藏当前对话", [
    { name: "title", label: "标题", value: page.title || "" },
    { name: "project", label: `放进哪个项目（${a.projects.map((p) => p.name).join(" / ")}）`, value: a.projects[0]?.name ?? "默认" },
    { name: "url", label: "地址", value: page.url },
  ]);
  if (!r) return;
  let p = a.projects.find((x) => x.name === r.project.trim());
  if (!p) {
    p = { id: uid(), name: r.project.trim() || "默认", collapsed: false, items: [] };
    a.projects.push(p);
  }
  const item = { id: uid(), title: r.title.trim() || r.url, url: r.url };
  p.items.unshift(item);
  activeConv = item.id;
  await save();
  render();
}

async function openConv(item) {
  activeConv = item.id;
  render();
  await invoke("navigate", { id: state.current, url: item.url });
}

async function projectMenu(p) {
  const a = acct();
  const r = await dialog(`项目：${p.name}`, [
    { name: "name", label: "名称", value: p.name },
    { name: "del", label: "输入 删除 可移除这个项目（只删收藏，不动 Hark 里的对话）" },
  ]);
  if (!r) return;
  if (r.del.trim() === "删除") a.projects = a.projects.filter((x) => x.id !== p.id);
  else p.name = r.name.trim() || p.name;
  await save();
  render();
}

/* ---------- 设置 ---------- */
async function settings() {
  const r = await dialog("设置", [
    {
      name: "css",
      label: "注入到 Hark 页面的样式（比如隐藏 Hark 自带侧栏），改完对新打开的账号页面生效",
      value: state.settings.css,
      textarea: true,
      placeholder: "/* 例：nav[aria-label=\"Sidebar\"] { display:none !important } */",
    },
  ]);
  if (!r) return;
  state.settings.css = r.css;
  await save();
  await invoke("reset_webviews");
  if (state.current) await invoke("show_account", { id: state.current, url: null, css: state.settings.css });
}

/* ---------- 渲染 ---------- */
function render() {
  const box = $("#accounts");
  box.innerHTML = "";
  for (const a of state.accounts) {
    const b = document.createElement("button");
    b.className = "avatar" + (a.id === state.current ? " active" : "");
    b.style.background = a.color;
    b.textContent = [...a.name][0] ?? "?";
    b.title = `${a.name}（右键改名/删除）`;
    b.onclick = () => selectAccount(a.id);
    b.oncontextmenu = (e) => accountMenu(a, e);
    box.append(b);
  }

  const a = acct();
  $("#account-name").textContent = a ? a.name : "未选择账号";
  $("#pane-empty").style.display = a ? "none" : "grid";
  const tree = $("#tree");
  tree.innerHTML = "";
  if (!a) return;
  for (const p of a.projects) {
    const wrap = document.createElement("div");
    if (p.collapsed) wrap.className = "collapsed";
    const head = document.createElement("div");
    head.className = "project-head";
    head.innerHTML = `<span>${p.collapsed ? "📁" : "📂"}</span><span class="name"></span><span class="acts"><button title="编辑">⋯</button></span>`;
    head.querySelector(".name").textContent = p.name;
    head.onclick = async (e) => {
      if (e.target.closest(".acts")) return projectMenu(p);
      p.collapsed = !p.collapsed;
      await save();
      render();
    };
    wrap.append(head);
    for (const it of p.items) {
      const c = document.createElement("button");
      c.className = "side-item conv" + (it.id === activeConv ? " active" : "");
      c.textContent = it.title;
      c.title = it.url;
      c.onclick = (e) => {
        if (e.target.classList.contains("del")) return;
        openConv(it);
      };
      const del = document.createElement("span");
      del.className = "del";
      del.textContent = "×";
      del.onclick = async () => {
        p.items = p.items.filter((x) => x.id !== it.id);
        await save();
        render();
      };
      c.append(del);
      wrap.append(c);
    }
    tree.append(wrap);
  }
}

/* ---------- 启动 ---------- */
$("#add-account").onclick = addAccount;
$("#add-project").onclick = addProject;
$("#pin-current").onclick = pinCurrent;
$("#open-settings").onclick = settings;
$("#new-chat").onclick = () => state.current && invoke("navigate", { id: state.current, url: HOME });
$("#reload").onclick = () => state.current && invoke("reload", { id: state.current });

(async () => {
  const raw = await invoke("load_state");
  if (raw) state = { ...state, ...JSON.parse(raw) };
  state.settings ??= { css: "" };
  render();
  await syncPane();
  if (state.current && acct()) await invoke("show_account", { id: state.current, url: null, css: state.settings.css });
})();
