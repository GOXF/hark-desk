// Hark Desk：让 hark.com 登录时的 Cloudflare Turnstile 人机验证能被看见。
// hark.com 用「interaction-only」隐形验证；需要人工点一下时，若当前步骤没有验证位，
// 它会把验证框渲染进一个 hidden 的 div，用户看不到，最后只得到
// 「Complete the verification and try again」。这里把那个容器取消隐藏，固定在页面底部居中。
// 验证框就绪后随机等待 1–5 秒，再通过账号 WebView 的原生输入点一次。
(() => {
  try {
    const host = location.hostname;
    if (!(host === "hark.com" || host.endsWith(".hark.com"))) return;
  } catch (_) {
    return;
  }
  if (window.__harkTurnstileFixInstalled) return;
  window.__harkTurnstileFixInstalled = true;

  const FIXED = "data-hark-turnstile-visible";
  const pending = new Map();
  const attempted = new WeakSet();
  const watched = new WeakMap();
  const ready = new WeakSet();
  let stopped = false;
  let verified = false;

  function cancelPending() {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  }

  function resetClick(iframe) {
    clearTimeout(pending.get(iframe));
    pending.delete(iframe);
    attempted.delete(iframe);
    verified = false;
  }

  function clickPoint(iframe) {
    if (stopped || verified || document.hidden || !iframe.isConnected || !ready.has(iframe)) return null;
    try {
      const url = new URL(iframe.src);
      if (url.protocol !== "https:" || url.hostname !== "challenges.cloudflare.com") return null;
    } catch (_) {
      return null;
    }
    const style = getComputedStyle(iframe);
    if (style.display === "none" || style.visibility !== "visible" || style.pointerEvents === "none") return null;
    for (let el = iframe; el; el = el.parentElement) {
      const ancestorStyle = getComputedStyle(el);
      if (ancestorStyle.display === "none" || parseFloat(ancestorStyle.opacity) === 0) return null;
    }
    const token = iframe.parentElement?.querySelector('[name="cf-turnstile-response"]');
    if (token?.value) return null;
    const rect = iframe.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 20) return null;
    const x = rect.left + 30;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    if (document.elementFromPoint(x, y) !== iframe) return null;
    return { x, y };
  }

  function scheduleClick(iframe) {
    const native = window.chrome?.webview;
    if (!native || typeof native.postMessage !== "function") return;
    if (pending.has(iframe) || attempted.has(iframe) || !clickPoint(iframe)) return;
    const delay = 1000 + Math.floor(Math.random() * 4001);
    pending.set(iframe, setTimeout(() => {
      pending.delete(iframe);
      const point = clickPoint(iframe);
      if (!point) return;
      attempted.add(iframe);
      native.postMessage({ type: "hark-turnstile-click", ...point });
    }, delay));
  }

  function reveal(iframe) {
    let el = iframe.parentElement;
    let hiddenBox = null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.hidden || getComputedStyle(el).display === "none") hiddenBox = el;
      el = el.parentElement;
    }
    if (!hiddenBox || hiddenBox.hasAttribute(FIXED)) return;
    hiddenBox.hidden = false;
    hiddenBox.setAttribute(FIXED, "1");
    Object.assign(hiddenBox.style, {
      display: "block",
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
    });
  }

  function scan() {
    if (stopped) return;
    for (const [iframe, timer] of pending) {
      if (!clickPoint(iframe)) {
        clearTimeout(timer);
        pending.delete(iframe);
      }
    }
    for (const f of document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')) {
      reveal(f);
      if (!watched.has(f)) {
        watched.set(f, f.src);
      } else if (watched.get(f) !== f.src) {
        watched.set(f, f.src);
        ready.delete(f);
        resetClick(f);
      }
      scheduleClick(f);
    }
  }

  // Turnstile 的错误被页面吞掉了；在开发者工具控制台里打一行，方便排查。
  function wrap(api) {
    if (!api || api.__harkWrapped || typeof api.render !== "function") return api;
    const render = api.render.bind(api);
    api.render = (container, opts) => {
      verified = false;
      if (opts && typeof opts === "object") {
        const onSuccess = opts.callback;
        opts.callback = (...args) => {
          verified = true;
          cancelPending();
          return typeof onSuccess === "function" && onSuccess(...args);
        };
        const onErr = opts["error-callback"];
        opts["error-callback"] = (code) => {
          console.warn("[Hark Desk] Turnstile 验证出错：", code);
          return onErr && onErr(code);
        };
        const onTimeout = opts["timeout-callback"];
        opts["timeout-callback"] = () => {
          console.warn("[Hark Desk] Turnstile 验证超时");
          return onTimeout && onTimeout();
        };
      }
      const id = render(container, opts);
      setTimeout(scan, 0);
      return id;
    };
    if (typeof api.reset === "function") {
      const reset = api.reset.bind(api);
      api.reset = (...args) => {
        const result = reset(...args);
        verified = false;
        cancelPending();
        for (const iframe of document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')) {
          resetClick(iframe);
        }
        setTimeout(scan, 0);
        return result;
      };
    }
    api.__harkWrapped = true;
    return api;
  }
  let current = window.turnstile;
  try {
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      get: () => current,
      set: (v) => {
        current = wrap(v);
      },
    });
  } catch (_) {}
  if (current) wrap(current);

  // 在 DOMContentLoaded 前监听，避免缓存 iframe 已加载但扫描还没开始的竞态。
  document.addEventListener("load", (event) => {
    const iframe = event.target;
    if (iframe.tagName !== "IFRAME") return;
    try {
      const url = new URL(iframe.src);
      if (url.protocol !== "https:" || url.hostname !== "challenges.cloudflare.com") return;
    } catch (_) {
      return;
    }
    ready.add(iframe);
    resetClick(iframe);
    scan();
  }, true);

  function start() {
    scan();
    const observer = new MutationObserver(scan);
    const observe = () => observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "src", "width", "height"],
    });
    observe();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelPending();
      else scan();
    });
    window.addEventListener("pagehide", () => {
      stopped = true;
      cancelPending();
      observer.disconnect();
    });
    window.addEventListener("pageshow", () => {
      if (!stopped) return;
      stopped = false;
      observe();
      scan();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
