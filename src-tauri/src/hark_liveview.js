// Hark Desk：hark.com 云电脑画面「放大 / 弹出」。
// 只在 hark.com 及其子域生效。云电脑画面由 Hark 服务器渲染，只能看不能操作；
// 这里只改变显示大小，不向画面发送任何输入。
// 识别规则是启发式的（够大但不铺满窗口的 iframe / canvas / video），拿到真实 DOM 后再收紧选择器：
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
    .hark-liveview-btns {
      position: fixed; z-index: 2147483646;
      display: flex; gap: 4px; opacity: .35; transition: opacity .15s;
    }
    .hark-liveview-btns:hover { opacity: 1; }
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
    .hark-liveview-btns.${BIG}-btns { top: 10px !important; right: 10px !important; left: auto !important; opacity: 1; z-index: 2147483647; }
  `;

  let current = null; // 当前放大的元素
  // 按钮不再塞进页面元素里（以前给父元素加 position:relative，会把登录页背景挤乱），
  // 而是挂在 body 上的 fixed 浮层，按元素位置摆放。
  const decorated = []; // { el, btns }
  const MAX_VIEWPORT_SHARE = 0.6; // 占满大半个窗口的多半是页面背景动画，不是云电脑画面

  function place() {
    const vw = window.innerWidth, vh = window.innerHeight;
    for (let i = decorated.length - 1; i >= 0; i--) {
      const d = decorated[i];
      if (!d.el.isConnected) {
        d.btns.remove();
        decorated.splice(i, 1);
        continue;
      }
      if (current && current.el === d.el) continue;
      const r = d.el.getBoundingClientRect();
      const visible = r.width >= MIN_W && r.height >= MIN_H && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      d.btns.style.display = visible ? "flex" : "none";
      if (visible) {
        d.btns.style.top = `${Math.max(r.top, 0) + 6}px`;
        d.btns.style.left = "auto";
        d.btns.style.right = `${Math.max(vw - Math.min(r.right, vw), 0) + 6}px`;
      }
    }
  }
  let placing = false;
  function schedulePlace() {
    if (placing) return;
    placing = true;
    requestAnimationFrame(() => {
      placing = false;
      place();
    });
  }

  function exitBig() {
    if (!current) return;
    current.el.classList.remove(BIG);
    current.btns.classList.remove(`${BIG}-btns`);
    current.bigBtn.textContent = "⛶ 放大";
    current = null;
    schedulePlace();
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
    if (r.width * r.height > window.innerWidth * window.innerHeight * MAX_VIEWPORT_SHARE) return;
    if (getComputedStyle(el).pointerEvents === "none") return;
    el.setAttribute(MARK, "1");

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
    document.body.appendChild(btns);
    decorated.push({ el, btns });
  }

  function scan() {
    for (const sel of LIVEVIEW_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) decorate(el);
    }
    if (current && !current.el.isConnected) current = null;
    schedulePlace();
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
    window.addEventListener("scroll", schedulePlace, true);
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
