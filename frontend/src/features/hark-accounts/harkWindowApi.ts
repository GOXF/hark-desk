// Hark 账号窗口（宿主直接建 WebView2，每账号独立数据目录）的前端封装。
// 后端：src-tauri/src/hark_window.rs。
import { useEffect, useState } from 'react';

import { isTauriClient } from '@/lib/desktopShell';

export type HarkAccount = { id: string; name: string; createdAt: number };

export type HarkAccountsState = {
  accounts: HarkAccount[];
  active: string | null;
  opened: string[];
  windowOpen: boolean;
  /** Hark 窗口是否吸附在主窗口右侧。 */
  docked: boolean;
};

export type HarkWindowAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'home'
  | 'devtools';

/** 打开方式：A 独立窗口（window），B 嵌入主窗口的 dockview 标签页（tab）。 */
export type HarkOpenMode = 'window' | 'tab';

/** 嵌入视图在主窗口里的位置，主窗口逻辑像素（= 前端 CSS px）。 */
export type HarkEmbedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const HARK_ACCOUNTS_EVENT = 'hark-accounts-changed';
/** 顶部切换条高度，要和 Rust 的 BAR_HEIGHT 一致。 */
export const HARK_BAR_HEIGHT = 40;

const EMPTY: HarkAccountsState = {
  accounts: [],
  active: null,
  opened: [],
  windowOpen: false,
  docked: true,
};

async function call<T>(cmd: string, args?: Record<string, unknown>) {
  if (!isTauriClient()) {
    throw new Error('Hark 账号仅桌面版可用');
  }
  const { tauriInvoke } = await import('@/lib/tauriApi');
  return tauriInvoke<T>(cmd, args);
}

export const harkWindowApi = {
  state: () => call<HarkAccountsState>('hark_accounts_state'),
  add: (name?: string) =>
    call<HarkAccount>('hark_accounts_add', { name: name ?? null }),
  rename: (id: string, name: string) =>
    call<void>('hark_accounts_rename', { id, name }),
  remove: (id: string) => call<void>('hark_accounts_remove', { id }),
  open: (id?: string) => call<void>('hark_window_open', { id: id ?? null }),
  action: (action: HarkWindowAction) =>
    call<void>('hark_window_action', { action }),
  setDock: (enabled: boolean) =>
    call<void>('hark_window_set_dock', { enabled }),
  /** B 方案：账号 WebView 作为主窗口原生子视图嵌在标签页里。后端：hark_embed.rs。 */
  embed: {
    /** 不存在则创建；设 bounds、显示并聚焦。 */
    show: (id: string, rect: HarkEmbedRect) =>
      call<void>('hark_embed_show', { id, rect }),
    /** 只更新 bounds，不改可见性。 */
    bounds: (id: string, rect: HarkEmbedRect) =>
      call<void>('hark_embed_bounds', { id, rect }),
    /** 隐藏（不销毁）。 */
    hide: (id: string) => call<void>('hark_embed_hide', { id }),
    /** 销毁。 */
    close: (id: string) => call<void>('hark_embed_close', { id }),
    action: (id: string, action: HarkWindowAction) =>
      call<void>('hark_embed_action', { id, action }),
  },
};

/** 订阅账号列表；后端每次变化都会广播 HARK_ACCOUNTS_EVENT。 */
export function useHarkAccounts(): HarkAccountsState {
  const [state, setState] = useState<HarkAccountsState>(EMPTY);
  useEffect(() => {
    if (!isTauriClient()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void harkWindowApi
      .state()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {});
    void import('@/lib/tauriApi').then(({ tauriListen }) =>
      tauriListen<HarkAccountsState>(HARK_ACCOUNTS_EVENT, (next) => {
        if (!cancelled) setState(next);
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return state;
}

const OPEN_MODE_KEY = 'hark.openMode';

/** 默认嵌入标签页（'tab'）；只有明确存过 'window' 才走独立窗口。 */
export function getHarkOpenMode(): HarkOpenMode {
  try {
    return localStorage.getItem(OPEN_MODE_KEY) === 'window' ? 'window' : 'tab';
  } catch {
    return 'tab';
  }
}

export function setHarkOpenMode(mode: HarkOpenMode): void {
  try {
    localStorage.setItem(OPEN_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}
