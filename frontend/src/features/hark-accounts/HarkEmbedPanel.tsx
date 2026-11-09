// B 方案：Hark 账号 WebView 嵌在 dockview 标签页里。
// 原生子视图（后端 hark_embed.rs）盖在 DOM 之上，按下方占位 div 的
// getBoundingClientRect() 同步位置；做法照抄 host-browser/HostBrowserPanel：
// ResizeObserver + window resize + 面板可见性 + 弹层遮挡（WorkspaceOverlay）。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Home,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';

import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { snapBrowserSurfaceRect } from '@/features/host-browser/browserSurfaceBounds';
import { isTauriClient } from '@/lib/desktopShell';
import { overlayCoversSurface } from '@/lib/nativeSurfaceOverlay';
import { isWorkspaceSurfaceActive } from '@/lib/workspaceSurface';
import { useLayoutStore } from '@/stores/useLayoutStore';

import {
  harkWindowApi,
  useHarkAccounts,
  type HarkEmbedRect,
  type HarkWindowAction,
} from './harkWindowApi';
import {
  harkEmbedTitle,
  markHarkEmbedMounted,
  scheduleHarkEmbedCloseCheck,
  type HarkEmbedPanelParams,
} from './openHarkEmbedTab';

const NAV_ACTIONS: {
  action: HarkWindowAction;
  title: string;
  icon: LucideIcon;
}[] = [
  { action: 'back', title: '后退', icon: ArrowLeft },
  { action: 'forward', title: '前进', icon: ArrowRight },
  { action: 'reload', title: '刷新', icon: RotateCw },
  { action: 'home', title: '主页', icon: Home },
  { action: 'devtools', title: '开发者工具', icon: Code2 },
];

const iconButtonClass =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 占位 div 的位置；宽高 < 1 或 NaN 视为不可显示。 */
function measureHost(host: HTMLElement | null): HarkEmbedRect | null {
  if (!host || !host.isConnected) return null;
  const rect = host.getBoundingClientRect();
  const snapped = snapBrowserSurfaceRect(rect, window.devicePixelRatio || 1);
  const valid =
    [snapped.x, snapped.y, snapped.width, snapped.height].every(
      Number.isFinite
    ) &&
    rect.width >= 1 &&
    rect.height >= 1;
  return valid ? snapped : null;
}

function rectKey(rect: HarkEmbedRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

export default function HarkEmbedPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as HarkEmbedPanelParams;
  const accountId = params.accountId ?? '';
  const { accounts } = useHarkAccounts();
  const account = accounts.find((a) => a.id === accountId);
  const accountName = account?.name ?? params.accountName ?? '账号';

  const overlay = useWorkspaceOverlay();
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const projectKey = useLayoutStore((state) => state.currentProjectKey);
  const projectKeyRef = useRef(projectKey);
  projectKeyRef.current = projectKey;

  const [dockVisible, setDockVisible] = useState(props.api.isVisible);
  const surfaceActive = isWorkspaceSurfaceActive(
    workspaceId,
    sessionId,
    activeTab
  );
  const panelVisible = dockVisible && surfaceActive;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(panelVisible);
  const occludedRef = useRef(false);
  /** 上次发给后端的状态：null = 已隐藏；字符串 = 显示中的 rect。 */
  const lastSentRef = useRef<string | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const failedRef = useRef(false);

  // 标题跟随账号改名
  useEffect(() => {
    if (account?.name) props.api.setTitle(harkEmbedTitle(account.name));
  }, [account?.name, props.api]);

  // 账号被删除（曾经出现过、现在不在列表里）→ 关掉标签
  const seenAccountRef = useRef(false);
  useEffect(() => {
    if (account) {
      seenAccountRef.current = true;
      return;
    }
    if (seenAccountRef.current) props.api.close();
  }, [account, props.api]);

  useEffect(() => {
    setDockVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange?.((event) => {
      setDockVisible(event.isVisible);
    });
    return () => disposable?.dispose();
  }, [props.api]);

  /** 串行发送，保证 show 一定先于 bounds/hide 到达后端。 */
  const enqueue = useCallback((work: () => Promise<void>): Promise<void> => {
    const next = chainRef.current.then(work, work);
    chainRef.current = next.catch(() => {});
    return chainRef.current;
  }, []);

  const sync = useCallback((): Promise<void> => {
    if (!accountId || !isTauriClient()) return Promise.resolve();
    const rect = measureHost(hostRef.current);
    const want =
      visibleRef.current && !occludedRef.current && !failedRef.current && rect;
    if (want) {
      const key = rectKey(rect);
      if (lastSentRef.current === key) return chainRef.current;
      const wasHidden = lastSentRef.current == null;
      lastSentRef.current = key;
      return enqueue(async () => {
        try {
          if (wasHidden) await harkWindowApi.embed.show(accountId, rect);
          else await harkWindowApi.embed.bounds(accountId, rect);
        } catch (err) {
          console.error('[hark-embed] show/bounds 失败', err);
          lastSentRef.current = null;
          if (wasHidden) {
            failedRef.current = true;
            setError(errorText(err));
          }
        }
      });
    }
    if (lastSentRef.current == null) return chainRef.current;
    lastSentRef.current = null;
    return enqueue(async () => {
      await harkWindowApi.embed.hide(accountId).catch((err: unknown) => {
        console.warn('[hark-embed] hide 失败', err);
      });
    });
  }, [accountId, enqueue]);

  // 可见性（切标签、最小化分组、离开工作区视图）
  useLayoutEffect(() => {
    visibleRef.current = panelVisible;
    void sync();
  }, [panelVisible, sync]);

  // 位置/尺寸变化
  useLayoutEffect(() => {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void sync();
      });
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    const host = hostRef.current;
    if (host) observer?.observe(host);
    const parent = host?.parentElement;
    if (parent) observer?.observe(parent);
    const groupEl = (props.api as { group?: { element?: HTMLElement } }).group
      ?.element;
    if (groupEl) observer?.observe(groupEl);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    const disposeDims = props.api.onDidDimensionsChange?.(schedule);
    // 只改位置不改尺寸的布局变化（侧栏开合）不触发 ResizeObserver，兜底轮询。
    const poll = window.setInterval(() => {
      if (document.hidden || !visibleRef.current) return;
      schedule();
    }, 500);
    schedule();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      disposeDims?.dispose();
      window.clearInterval(poll);
    };
  }, [props.api, sync, error]);

  // 弹层遮挡：H 菜单、下拉、对话框等 HTML 浮层盖到嵌入区时临时 hide
  useLayoutEffect(() => overlay.registerNativeSurfaceHost(), [overlay]);
  useLayoutEffect(() => {
    return overlay.subscribeNativeSurfaceOcclusion((occlusion) => {
      let covered = occlusion.hide;
      if (!covered && occlusion.rects.length > 0) {
        const rect = hostRef.current?.getBoundingClientRect();
        covered =
          !!rect &&
          rect.width >= 2 &&
          rect.height >= 2 &&
          overlayCoversSurface(
            {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            },
            occlusion.rects
          );
      }
      occludedRef.current = covered;
      void sync().finally(() => overlay.ackOverlayReady());
    });
  }, [overlay, sync]);

  // 挂载记账；卸载：先 hide，再延迟判定是否是「关闭标签」→ close
  useEffect(() => {
    if (!accountId) return undefined;
    const unmark = markHarkEmbedMounted(accountId);
    return () => {
      unmark();
      if (lastSentRef.current != null) {
        lastSentRef.current = null;
        void enqueue(async () => {
          await harkWindowApi.embed.hide(accountId).catch(() => {});
        });
      }
      scheduleHarkEmbedCloseCheck(accountId, projectKeyRef.current);
    };
  }, [accountId, enqueue]);

  const runAction = (action: HarkWindowAction) => {
    if (!accountId) return;
    void harkWindowApi.embed.action(accountId, action).catch((err: unknown) => {
      console.error(`[hark-embed] ${action} 失败`, err);
    });
  };

  const retry = () => {
    failedRef.current = false;
    lastSentRef.current = null;
    setError(null);
    setRetryEpoch((n) => n + 1);
  };

  useEffect(() => {
    if (retryEpoch > 0) void sync();
  }, [retryEpoch, sync]);

  const unavailable = !isTauriClient()
    ? 'Hark 嵌入标签仅桌面版可用'
    : !accountId
      ? '这个标签没有关联的 Hark 账号'
      : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5 text-xs">
        {NAV_ACTIONS.map(({ action, title, icon: Icon }) => (
          <button
            key={action}
            type="button"
            title={title}
            aria-label={title}
            className={iconButtonClass}
            disabled={!!unavailable || !!error}
            onClick={() => runAction(action)}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <span className="ml-1.5 min-w-0 truncate text-muted-foreground">
          Hark · {accountName}
        </span>
      </div>
      <div
        ref={hostRef}
        className="relative min-h-0 flex-1"
        data-hark-embed-host={accountId}
      >
        {unavailable || error ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <span>{unavailable ?? `嵌入 Hark 账号失败：${error}`}</span>
            {error ? (
              <button
                type="button"
                className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={retry}
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
