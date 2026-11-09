// B 方案（嵌入标签页）的打开入口与生命周期记账。
// 照抄 host-browser/openBrowserTab.ts 的做法：菜单只发请求，真正 addPanel 的
// handler 由 PanelActionsProvider 注册（它持有 dockview api）；handler 未就绪时排队。
import type { DockviewApi } from 'dockview-react';

import { useLayoutStore } from '@/stores/useLayoutStore';

import { harkWindowApi } from './harkWindowApi';

/** dockview 面板组件 id（PanelRegistry 的 BASE_PANEL_COMPONENTS 里注册）。 */
export const HARK_EMBED_PANEL_COMPONENT = 'hark-embed';
const PANEL_ID_PREFIX = 'hark-embed:';
const TITLE_PREFIX = 'Hark · ';

export type HarkEmbedOpenRequest = {
  accountId: string;
  accountName: string;
};

export type HarkEmbedPanelParams = {
  accountId?: string;
  accountName?: string;
};

export function harkEmbedPanelId(accountId: string): string {
  return `${PANEL_ID_PREFIX}${accountId}`;
}

export function harkEmbedTitle(accountName: string): string {
  return `${TITLE_PREFIX}${accountName}`;
}

type HarkEmbedOpenHandler = (request: HarkEmbedOpenRequest) => void;

const pending: HarkEmbedOpenRequest[] = [];
let handler: HarkEmbedOpenHandler | null = null;
let getDockviewApi: () => DockviewApi | null = () => null;

/**
 * PanelActionsProvider 调用：注册打开 handler 和取当前 dockview api 的方法。
 * 传 null 注销。
 */
export function setHarkEmbedOpenHandler(
  next: HarkEmbedOpenHandler | null,
  apiGetter?: () => DockviewApi | null
): void {
  handler = next;
  getDockviewApi = next && apiGetter ? apiGetter : () => null;
  if (!handler) return;
  const queued = pending.splice(0, pending.length);
  for (const request of queued) handler(request);
}

/** 打开（或聚焦已有的）某账号的嵌入标签。返回 false 表示已排队等工作区就绪。 */
export function requestHarkEmbedOpen(request: HarkEmbedOpenRequest): boolean {
  if (!request.accountId) return false;
  if (handler) {
    handler(request);
    return true;
  }
  // 同账号只留最后一个请求
  const index = pending.findIndex((r) => r.accountId === request.accountId);
  if (index >= 0) pending.splice(index, 1);
  pending.push(request);
  return false;
}

/** 由 handler 调用：同账号已有标签则聚焦，否则在编辑区新开。 */
export function openOrFocusHarkEmbedPanel(
  api: DockviewApi,
  request: HarkEmbedOpenRequest,
  addPanel: (options: {
    id: string;
    component: string;
    title: string;
    params: HarkEmbedPanelParams;
    renderer: 'onlyWhenVisible';
  }) => { api: { setActive: () => void } } | undefined
): void {
  const panelId = harkEmbedPanelId(request.accountId);
  const title = harkEmbedTitle(request.accountName);
  const existing =
    api.getPanel(panelId) ??
    api.panels.find(
      (panel) =>
        (panel.params as HarkEmbedPanelParams | undefined)?.accountId ===
        request.accountId
    );
  if (existing) {
    existing.api.setTitle(title);
    existing.api.updateParameters({
      accountId: request.accountId,
      accountName: request.accountName,
    });
    existing.group.api.setVisible(true);
    existing.api.setActive();
    return;
  }
  const options = {
    id: panelId,
    component: HARK_EMBED_PANEL_COMPONENT,
    title,
    params: { accountId: request.accountId, accountName: request.accountName },
    renderer: 'onlyWhenVisible' as const,
  };
  let panel = addPanel(options);
  if (!panel) {
    try {
      panel = api.addPanel(options);
    } catch (error) {
      console.error('[hark-embed] 打开嵌入标签失败', error);
    }
  }
  panel?.api.setActive();
}

// ---- 生命周期：区分「切走/卸载」（hide）与「关闭标签」（close） ----

const mounted = new Map<string, number>();

export function markHarkEmbedMounted(accountId: string): () => void {
  mounted.set(accountId, (mounted.get(accountId) ?? 0) + 1);
  return () => {
    const next = (mounted.get(accountId) ?? 1) - 1;
    if (next <= 0) mounted.delete(accountId);
    else mounted.set(accountId, next);
  };
}

/** 组件卸载后多久判定是否真关闭；要长于 fromJSON 重建（同步）和一次重挂载。 */
const CLOSE_CHECK_DELAY_MS = 800;

function accountPanelStillOpen(api: DockviewApi, accountId: string): boolean {
  try {
    return api.panels.some(
      (panel) =>
        panel.id === harkEmbedPanelId(accountId) ||
        (panel.params as HarkEmbedPanelParams | undefined)?.accountId ===
          accountId
    );
  } catch {
    return true;
  }
}

/**
 * 面板组件卸载时调用（已先 hide）。延迟检查：
 * - 同账号又挂载了（重排布局 / 重新打开）→ 保留；
 * - dockview 不在了（离开工作区路由）→ 保留隐藏，回来时布局恢复会重新 show；
 * - 切换了项目 → 保留隐藏（那个项目的布局里还有它）；
 * - 当前 dockview 里已没有该账号的面板 → 用户关了标签 → close。
 */
export function scheduleHarkEmbedCloseCheck(
  accountId: string,
  projectKey: string
): void {
  window.setTimeout(() => {
    if ((mounted.get(accountId) ?? 0) > 0) return;
    const api = getDockviewApi();
    if (!api) return;
    if (useLayoutStore.getState().currentProjectKey !== projectKey) return;
    if (accountPanelStillOpen(api, accountId)) return;
    void harkWindowApi.embed.close(accountId).catch((error) => {
      console.warn('[hark-embed] 关闭嵌入视图失败', error);
    });
  }, CLOSE_CHECK_DELAY_MS);
}
