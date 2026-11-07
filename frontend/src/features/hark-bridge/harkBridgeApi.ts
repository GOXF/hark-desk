// 文件桥 Tauri 命令封装。只在桌面版（Tauri 客户端）可用。
import { useCallback, useEffect, useState } from 'react';

import { isTauriClient } from '@/lib/desktopShell';

import {
  HARK_BRIDGE_COMMANDS as CMD,
  HARK_BRIDGE_STATE_EVENT,
  type HarkBridgeConfirmAnswer,
  type HarkBridgePatch,
  type HarkBridgeState,
  type HarkBridgeTunnelSaveArgs,
} from './types';

export const HARK_BRIDGE_SETTINGS_PATH = '/settings/hark-bridge';

async function call<T>(cmd: string, args?: Record<string, unknown>) {
  if (!isTauriClient()) {
    throw new Error('文件桥仅桌面版可用');
  }
  const { tauriInvoke } = await import('@/lib/tauriApi');
  return tauriInvoke<T>(cmd, args);
}

export const harkBridgeApi = {
  state: () => call<HarkBridgeState>(CMD.state),
  saveTunnel: (args: HarkBridgeTunnelSaveArgs) =>
    call<HarkBridgeState>(CMD.tunnelSave, { ...args }),
  create: (name: string, folder: string) =>
    call<HarkBridgeState>(CMD.create, { name, folder }),
  update: (id: string, patch: HarkBridgePatch) =>
    call<HarkBridgeState>(CMD.update, { id, patch }),
  remove: (id: string) => call<HarkBridgeState>(CMD.delete, { id }),
  start: (id: string) => call<HarkBridgeState>(CMD.start, { id }),
  stop: (id: string) => call<HarkBridgeState>(CMD.stop, { id }),
  setDefault: (id: string) => call<HarkBridgeState>(CMD.setDefault, { id }),
  bind: (profileId: string, bridgeId: string, projectUrl: string) =>
    call<HarkBridgeState>(CMD.bind, { profileId, bridgeId, projectUrl }),
  unbind: (profileId: string) =>
    call<HarkBridgeState>(CMD.unbind, { profileId }),
  connectMessage: (bridgeId: string) =>
    call<string>(CMD.connectMessage, { bridgeId }),
  send: (profileId: string) => call<void>(CMD.send, { profileId }),
  confirm: (bridgeId: string, reqId: string, answer: HarkBridgeConfirmAnswer) =>
    call<HarkBridgeState>(CMD.confirm, { bridgeId, reqId, answer }),
  logs: (id: string) => call<string[]>(CMD.logs, { id }),
};

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 读取文件桥状态，并订阅后台推送的 hark-bridge://state 事件。 */
export function useHarkBridgeState(enabled: boolean) {
  const [state, setState] = useState<HarkBridgeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await harkBridgeApi.state();
      setState(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void refresh();
    void import('@/lib/tauriApi')
      .then(({ tauriListen }) =>
        tauriListen<HarkBridgeState>(HARK_BRIDGE_STATE_EVENT, (payload) => {
          if (!disposed && payload) setState(payload);
        })
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, refresh]);

  return { state, loadError, refresh };
}
