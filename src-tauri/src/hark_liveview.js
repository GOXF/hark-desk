// Hark Desk：hark.com 云电脑画面「放大 / 弹出」。
// 只在 hark.com 及其子域生效。云电脑画面由 Hark 服务器渲染，只能看不能操作；
// 这里只改变显示大小，不向画面发送任何输入。
// 识别规则是启发式的（够大的 iframe / canvas / video），拿到真实 DOM 后再收紧选择器：
// 改 LIVEVIEW_SELECTORS 即可。
(() => {
  try {
    const host = location.hostname;
    if (!(host === "hark.com" || host.endsWith(".hark.com"))) return;
  } catch (_) {
    return;
  }
  if (window.__harkLiveviewInstalled) return;
  window.__harkLiveviewInstalled = true;

  // 以后有确定的选择器就放在最前面，例如 '[data-testid="browser-live-view"]'。
  const LIVEVIEW_SELECTORS = ["iframe", "canvas", "video"];
  const MIN_W = 240;
  const MIN_H = 135;
  const MARK = "data-hark-liveview";
  const BIG = "hark-liveview-big";

  const style = document.createElement("style");
  style.textContent = `
    [${MARK}-wrap] { position: relative !important; }
    .hark-liveview-btns {
      position: absolute; top: 6px; right: 6px; z-index: 2147483646;
      display: flex; gap: 4px; opacity: .25; transition: opacity .15s;
    }
    [${MARK}-wrap]:hover .hark-liveview-btns, .hark-liveview-btns:hover { opacity: 1; }
    .hark-liveview-btns button {
      font: 12px/1 system-ui, sans-serif; padding: 5px 8px; border: 0; border-radius: 6px;
      background: rgba(0,0,0,.65); color: #fff; cursor: pointer;
    }
    .${BIG} {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important; margin: 0 !important;
      z-index: 2147483645 !important; background: #000 !important; object-fit: contain !important;
      border-radius: 0 !important; transform: none !important;
    }
    .hark-liveview-btns.${BIG}-btns { position: fixed; top: 10px; right: 10px; opacity: 1; z-index: 2147483647; }
  `;

  let current = null; // 当前放大的元素

  function exitBig() {
    if (!current) return;
    current.el.classList.remove(BIG);
    current.btns.classList.remove(`${BIG}-btns`);
    current.bigBtn.textContent = "⛶ 放大";
    current = null;
  }

  function enterBig(el, btns, bigBtn) {
    exitBig();
    el.classList.add(BIG);
    btns.classList.add(`${BIG}-btns`);
    bigBtn.textContent = "✕ 还原 (Esc)";
    current = { el, btns, bigBtn };
  }

  function popupUrl(el) {
    if (el.tagName === "IFRAME") {
      const src = el.getAttribute("src") || "";
      if (src && !src.startsWith("about:") && !src.startsWith("javascript:")) {
        try {
          return new URL(src, location.href).href;
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  function decorate(el) {
    if (el.hasAttribute(MARK)) return;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return;
    const parent = el.parentElement;
    if (!parent) return;
    el.setAttribute(MARK, "1");
    parent.setAttribute(`${MARK}-wrap`, "1");

    const btns = document.createElement("div");
    btns.className = "hark-liveview-btns";
    const bigBtn = document.createElement("button");
    bigBtn.type = "button";
    bigBtn.textContent = "⛶ 放大";
    bigBtn.title = "让云电脑画面铺满窗口";
    bigBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (current && current.el === el) exitBig();
      else enterBig(el, btns, bigBtn);
    });
    btns.appendChild(bigBtn);

    const url = popupUrl(el);
    if (url) {
      const popBtn = document.createElement("button");
      popBtn.type = "button";
      popBtn.textContent = "↗ 弹出";
      popBtn.title = "在新窗口打开云电脑画面（同一账号）";
      popBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 尺寸不要改：hark_window.rs 的 is_liveview_popup 靠 1280x800 认出它并留在应用内。
        window.open(url, "_blank", "popup,width=1280,height=800");
      });
      btns.appendChild(popBtn);
    }
    parent.appendChild(btns);
  }

  function scan() {
    for (const sel of LIVEVIEW_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) decorate(el);
    }
    if (current && !current.el.isConnected) current = null;
  }

  function start() {
    (document.head || document.documentElement).appendChild(style);
    scan();
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        scan();
      }, 500);
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", scan);
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && current) {
          exitBig();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
