import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const { JSDOM } = require("jsdom");
const script = readFileSync(
  new URL("./hark_turnstile.js", import.meta.url),
  "utf8",
);

function fixture({
  random = 0.5,
  url = "https://hark.com/login",
  loaded = true,
} = {}) {
  const dom = new JSDOM(
    '<div hidden><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/test"></iframe><input name="cf-turnstile-response"></div>',
    {
      url,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const { document } = window;
  const frame = document.querySelector("iframe");
  const box = frame.parentElement;
  const messages = [];
  const timers = new Map();
  const observers = [];
  const Observer = window.MutationObserver;
  window.MutationObserver = class extends Observer {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  let now = 0;
  let nextId = 0;
  let blocked = false;
  Object.defineProperty(document, "readyState", { value: "complete" });
  Object.defineProperty(window.Math, "random", { value: () => random });
  frame.getBoundingClientRect = () => ({
    x: 100,
    y: 200,
    left: 100,
    top: 200,
    width: 300,
    height: 65,
    right: 400,
    bottom: 265,
  });
  document.elementFromPoint = () => (blocked ? document.body : frame);
  window.chrome = {
    webview: {
      postMessage: (payload) =>
        messages.push({
          at: now,
          payload: JSON.parse(JSON.stringify(payload)),
        }),
    },
  };
  window.setTimeout = (fn, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, fn });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const tick = (duration) => {
    const end = now + duration;
    for (;;) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  };
  window.eval(script);
  if (loaded) frame.dispatchEvent(new window.Event("load"));
  const close = () => {
    observers.forEach((observer) => observer.disconnect());
    window.close();
  };
  return {
    close,
    window,
    document,
    frame,
    box,
    messages,
    tick,
    block: () => {
      blocked = true;
    },
  };
}

test("reveals a hidden verification widget without clicking immediately", (t) => {
  const f = fixture();
  t.after(f.close);
  assert.equal(f.box.hidden, false);
  assert.equal(f.box.style.position, "fixed");
  assert.equal(f.messages.length, 0);
});

test("waits the selected three seconds, then requests one native checkbox click", (t) => {
  const f = fixture({ random: 0.5 });
  t.after(f.close);
  f.tick(2999);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.deepEqual(f.messages, [
    { at: 3000, payload: { type: "hark-turnstile-click", x: 130, y: 232.5 } },
  ]);
  f.tick(10000);
  assert.equal(f.messages.length, 1);
});

for (const [random, delay] of [
  [0, 1000],
  [0.9999999999999999, 5000],
]) {
  test(`waits ${delay}ms at the random range boundary`, (t) => {
    const f = fixture({ random });
    t.after(f.close);
    f.tick(delay - 1);
    assert.equal(f.messages.length, 0);
    f.tick(1);
    assert.equal(f.messages[0].at, delay);
  });
}

for (const [name, cancel] of [
  ["removed widget", (f) => f.frame.remove()],
  ["covered checkbox", (f) => f.block()],
  [
    "completed verification",
    (f) => {
      f.document.querySelector("input").value = "completed-token";
    },
  ],
  [
    "hidden page",
    (f) => {
      Object.defineProperty(f.document, "hidden", { value: true });
    },
  ],
  [
    "navigated page",
    (f) => f.window.dispatchEvent(new f.window.Event("pagehide")),
  ],
]) {
  test(`cancels the pending click for a ${name}`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.tick(1000);
    cancel(f);
    f.tick(10000);
    assert.equal(f.messages.length, 0);
  });
}

test("does not act on lookalike websites", (t) => {
  const f = fixture({ url: "https://evilhark.com/login" });
  t.after(f.close);
  f.tick(10000);
  assert.equal(f.box.hidden, true);
  assert.equal(f.messages.length, 0);
});

test("starts a fresh delay if the widget reloads while waiting", async (t) => {
  const f = fixture();
  t.after(f.close);
  f.tick(2500);
  f.frame.src += "?new-challenge=1";
  await Promise.resolve();
  f.frame.dispatchEvent(new f.window.Event("load"));
  f.tick(2999);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.equal(f.messages[0].at, 5500);
});

test("starts the delay only after the verification iframe has loaded", (t) => {
  const f = fixture({ loaded: false });
  t.after(f.close);
  f.tick(5000);
  assert.equal(f.messages.length, 0);
  f.frame.dispatchEvent(new f.window.Event("load"));
  f.tick(2999);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.equal(f.messages[0].at, 8000);
});

for (const target of ["frame", "box"]) {
  test(`does not click when the ${target} is fully transparent`, (t) => {
    const f = fixture();
    t.after(f.close);
    f[target].style.opacity = "0";
    f.tick(10000);
    assert.equal(f.messages.length, 0);
  });
}

for (const restart of ["load", "reset"]) {
  test(`a successful widget can start a new delayed ${restart} cycle`, (t) => {
    const f = fixture();
    t.after(f.close);
    f.window.turnstile = {
      render: () => "widget",
      reset: () => "reset-result",
    };
    const opts = {};
    f.window.turnstile.render("container", opts);
    f.tick(1000);
    opts.callback("verified-token");
    f.tick(5000);
    assert.equal(f.messages.length, 0);
    if (restart === "load") f.frame.dispatchEvent(new f.window.Event("load"));
    else assert.equal(f.window.turnstile.reset("widget"), "reset-result");
    f.tick(2999);
    assert.equal(f.messages.length, 0);
    f.tick(1);
    assert.equal(f.messages[0].at, 9000);
  });
}

test("restores a fresh delay after returning from the page cache", (t) => {
  const f = fixture();
  t.after(f.close);
  f.tick(2500);
  f.window.dispatchEvent(new f.window.Event("pagehide"));
  f.tick(5000);
  assert.equal(f.messages.length, 0);
  f.window.dispatchEvent(new f.window.Event("pageshow"));
  f.tick(2999);
  assert.equal(f.messages.length, 0);
  f.tick(1);
  assert.equal(f.messages[0].at, 10500);
});
