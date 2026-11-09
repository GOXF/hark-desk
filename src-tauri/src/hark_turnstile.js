// Hark Desk：让 hark.com 登录时的 Cloudflare Turnstile 人机验证能被看见。
// hark.com 用「interaction-only」隐形验证；需要人工点一下时，若当前步骤没有验证位，
// 它会把验证框渲染进一个 hidden 的 div，用户看不到，最后只得到
// 「Complete the verification and try again」。这里把那个容器取消隐藏，固定在页面底部居中。
// 不需要交互时 Turnstile 不占空间，所以平时看不到任何东西。
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
    for (const f of document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')) reveal(f);
  }

  // Turnstile 的错误被页面吞掉了；在开发者工具控制台里打一行，方便排查。
  function wrap(api) {
    if (!api || api.__harkWrapped || typeof api.render !== "function") return api;
    const render = api.render.bind(api);
    api.render = (container, opts) => {
      if (opts && typeof opts === "object") {
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

  function start() {
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
