import { invoke } from "@tauri-apps/api/core";

const HOME = "https://hark.com/";
const COLORS = ["#2f6bff", "#14a37f", "#e2683c", "#8b5cf6", "#d93f87", "#0e9ab8", "#c99a06", "#555"];
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);

// state: { accounts: [{id,name,color,projects:[{id,name,collapsed,items:[{id,title,url}]}]}], current, settings:{css} }
let state = { accounts: [], current: null, settings: { css: "" } };
let activeConv = null;

/* ---------- 线条图标（lucide 风格） ---------- */
const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  fwd: '<path d="M9 18l6-6-6-6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderopen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.5 12H7.2a2 2 0 0 0-1.9 1.4L3 19"/>',
  folderplus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24">${ICONS[n] ?? ""}</svg>`;
function paintIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (!el.dataset.painted) {
      el.insertAdjacentHTML("afterbegin", svg(el.dataset.icon));
      el.dataset.painted = "1";
    }
  });
}
const SHOW_LIMIT = 5;
const expanded = new Set();
let filter = "";

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
    { name: "title", label: "标题", value: cleanTitle(page.title, page.url) },
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

// 页面标题去掉 " | Hark" / " - Hark" 之类的站名后缀；拿不到就用地址最后一段
function cleanTitle(title, url) {
  let t = (title || "").trim().replace(/\s*[|\-–—·]\s*Hark\s*$/i, "").trim();
  if (!t || /^hark$/i.test(t)) {
    try {
      const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
      t = seg ? `对话 ${decodeURIComponent(seg).slice(0, 8)}` : "";
    } catch {}
  }
  return t;
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
  $("#account-name .txt").textContent = a ? a.name : "未选择账号";
  $("#pane-empty").style.display = a ? "none" : "grid";
  const tree = $("#tree");
  tree.innerHTML = "";
  if (!a) return;
  const q = filter.trim().toLowerCase();
  for (const p of a.projects) {
    const items = q ? p.items.filter((it) => it.title.toLowerCase().includes(q) || it.url.toLowerCase().includes(q)) : p.items;
    if (q && !items.length) continue;
    const open = q || !p.collapsed;
    const wrap = document.createElement("div");
    wrap.className = "project" + (open ? "" : " collapsed");
    const head = document.createElement("div");
    head.className = "project-head";
    head.innerHTML = `${svg(open ? "folderopen" : "folder")}<span class="name"></span><span class="acts"><button title="编辑">${svg("dots")}</button></span>`;
    head.querySelector(".name").textContent = p.name;
    head.onclick = async (e) => {
      if (e.target.closest(".acts")) return projectMenu(p);
      p.collapsed = !p.collapsed;
      await save();
      render();
    };
    wrap.append(head);
    const limit = q || expanded.has(p.id) ? Infinity : SHOW_LIMIT;
    items.slice(0, limit).forEach((it) => {
      const c = document.createElement("button");
      c.className = "side-item conv" + (it.id === activeConv ? " active" : "");
      c.textContent = it.title;
      c.title = it.url;
      c.onclick = (e) => {
        if (e.target.closest(".del")) return;
        openConv(it);
      };
      const del = document.createElement("span");
      del.className = "del";
      del.title = "取消收藏";
      del.innerHTML = svg("x");
      del.onclick = async () => {
        p.items = p.items.filter((x) => x.id !== it.id);
        await save();
        render();
      };
      c.append(del);
      wrap.append(c);
    });
    if (items.length > limit) {
      const more = document.createElement("button");
      more.className = "side-item more";
      more.textContent = "展开显示";
      more.onclick = () => { expanded.add(p.id); render(); };
      wrap.append(more);
    } else if (!q && expanded.has(p.id) && items.length > SHOW_LIMIT) {
      const less = document.createElement("button");
      less.className = "side-item more";
      less.textContent = "收起";
      less.onclick = () => { expanded.delete(p.id); render(); };
      wrap.append(less);
    }
    if (!items.length) {
      const h = document.createElement("div");
      h.className = "empty-hint";
      h.textContent = "还没有收藏";
      wrap.append(h);
    }
    tree.append(wrap);
  }
}

/* ---------- 标题栏：显示当前页面标题，后退/前进 ---------- */
async function refreshHead() {
  const a = acct();
  if (!a) {
    $("#conv-title").textContent = "Hark Desk";
    return;
  }
  try {
    const page = await invoke("current_page", { id: a.id });
    const t = cleanTitle(page.title, page.url) || "Hark";
    if ($("#conv-title").textContent !== t) $("#conv-title").textContent = t;
  } catch {}
}
setInterval(refreshHead, 1500);

function toggleSidebar() {
  document.body.classList.toggle("side-hidden");
  state.settings.sideHidden = document.body.classList.contains("side-hidden");
  save();
}

/* ---------- 启动 ---------- */
paintIcons();
$("#add-account").onclick = addAccount;
$("#empty-add").onclick = addAccount;
$("#add-project").onclick = addProject;
$("#pin-current").onclick = pinCurrent;
$("#open-settings").onclick = settings;
$("#account-name").onclick = (e) => acct() && accountMenu(acct(), e);
$("#new-chat").onclick = () => state.current && invoke("navigate", { id: state.current, url: HOME });
$("#reload").onclick = () => state.current && invoke("reload", { id: state.current });
$("#go-back").onclick = () => state.current && invoke("history_go", { id: state.current, delta: -1 });
$("#go-fwd").onclick = () => state.current && invoke("history_go", { id: state.current, delta: 1 });
$("#toggle-side").onclick = toggleSidebar;
$("#search-btn").onclick = () => {
  const el = $("#search");
  el.hidden = !el.hidden;
  if (el.hidden) { el.value = ""; filter = ""; render(); } else el.focus();
};
$("#search").oninput = (e) => { filter = e.target.value; render(); };
$("#search").onkeydown = (e) => { if (e.key === "Escape") $("#search-btn").click(); };
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
  if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); if ($("#search").hidden) $("#search-btn").click(); else $("#search").focus(); }
});

(async () => {
  const raw = await invoke("load_state");
  if (raw) state = { ...state, ...JSON.parse(raw) };
  state.settings ??= { css: "" };
  if (state.settings.sideHidden) document.body.classList.add("side-hidden");
  render();
  await syncPane();
  if (state.current && acct()) await invoke("show_account", { id: state.current, url: null, css: state.settings.css });
  refreshHead();
})();
