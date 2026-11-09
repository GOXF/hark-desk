// Hark 账号窗口顶部的「账号切换条」。
// 高度严格等于 HARK_BAR_HEIGHT；切换条下方是 Rust 叠放的各账号 hark.com 子 WebView，
// 所以这里不能用向下弹出的浮层菜单（会被子 WebView 盖住），
// 重命名/删除做成 chip 内的悬停小按钮（右键 chip 也可固定显示）。
import { useCallback, useState, type MouseEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Home,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  HARK_BAR_HEIGHT,
  harkWindowApi,
  useHarkAccounts,
  type HarkAccount,
  type HarkWindowAction,
} from './harkWindowApi';

/** 这个窗口没有 toast 宿主，出错时用 console + alert 简短提示。 */
function reportError(message: string, error: unknown) {
  console.error(`[hark-window] ${message}`, error);
  const detail = error instanceof Error ? error.message : String(error ?? '');
  window.alert(detail ? `${message}：${detail}` : message);
}

/** 头像首字母：取名字第一个字符（英文转大写）。 */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

const NAV_ACTIONS: { action: HarkWindowAction; title: string; icon: LucideIcon }[] =
  [
    { action: 'back', title: '后退', icon: ArrowLeft },
    { action: 'forward', title: '前进', icon: ArrowRight },
    { action: 'reload', title: '刷新', icon: RotateCw },
    { action: 'home', title: '主页', icon: Home },
    { action: 'devtools', title: '开发者工具', icon: Code2 },
  ];

const iconButtonClass =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

type AccountChipProps = {
  account: HarkAccount;
  active: boolean;
  opened: boolean;
  menuPinned: boolean;
  onOpen: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onRename: (account: HarkAccount) => void;
  onRemove: (account: HarkAccount) => void;
};

function AccountChip({
  account,
  active,
  opened,
  menuPinned,
  onOpen,
  onTogglePinned,
  onRename,
  onRemove,
}: AccountChipProps) {
  const handleContextMenu = (event: MouseEvent) => {
    // 右键：固定/收起 chip 内的小菜单
    event.preventDefault();
    onTogglePinned(account.id);
  };

  return (
    <div
      className={cn(
        'group relative flex h-7 max-w-[200px] shrink-0 items-center rounded-full border text-sm transition-colors',
        active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        className="flex h-full min-w-0 items-center gap-1.5 pl-0.5 pr-2.5"
        title={opened ? `${account.name}（已打开）` : account.name}
        aria-pressed={active}
        onClick={() => onOpen(account.id)}
      >
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            active
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-foreground'
          )}
          aria-hidden
        >
          {initialOf(account.name)}
        </span>
        <span className="truncate">{account.name}</span>
        {opened ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"
            aria-label="已打开"
          />
        ) : null}
      </button>
      {/* 悬停或右键固定时显示的小菜单：重命名 / 删除 */}
      <div
        className={cn(
          'items-center gap-0.5 pr-1',
          menuPinned ? 'flex' : 'hidden group-hover:flex'
        )}
      >
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          title="重命名"
          onClick={() => onRename(account)}
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-destructive"
          title="删除"
          onClick={() => onRemove(account)}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export function HarkWindowBar() {
  const { accounts, active, opened, docked } = useHarkAccounts();
  const [busy, setBusy] = useState(false);
  const [pinnedMenuId, setPinnedMenuId] = useState<string | null>(null);

  const openAccount = useCallback((id: string) => {
    setPinnedMenuId(null);
    harkWindowApi.open(id).catch((error) => reportError('打开账号失败', error));
  }, []);

  const addAccount = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await harkWindowApi.add();
      await harkWindowApi.open(created.id);
    } catch (error) {
      reportError('添加账号失败', error);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const renameAccount = useCallback(async (account: HarkAccount) => {
    const next = window.prompt('重命名账号', account.name)?.trim();
    setPinnedMenuId(null);
    if (!next || next === account.name) return;
    try {
      await harkWindowApi.rename(account.id, next);
    } catch (error) {
      reportError('重命名失败', error);
    }
  }, []);

  const removeAccount = useCallback(async (account: HarkAccount) => {
    const ok = window.confirm(
      `确定删除账号「${account.name}」吗？\n删除会清除该账号登录数据。`
    );
    setPinnedMenuId(null);
    if (!ok) return;
    try {
      await harkWindowApi.remove(account.id);
    } catch (error) {
      reportError('删除账号失败', error);
    }
  }, []);

  const runAction = useCallback((action: HarkWindowAction, title: string) => {
    harkWindowApi
      .action(action)
      .catch((error) => reportError(`${title}失败`, error));
  }, []);

  const togglePinned = useCallback((id: string) => {
    setPinnedMenuId((current) => (current === id ? null : id));
  }, []);

  const toggleDock = useCallback(() => {
    harkWindowApi
      .setDock(!docked)
      .catch((error) => reportError('切换吸附失败', error));
  }, [docked]);

  const hasActive = active !== null;

  return (
    <div
      className="flex w-full select-none items-center gap-2 overflow-hidden border-b border-border bg-background px-2 text-foreground"
      style={{ height: HARK_BAR_HEIGHT, minHeight: HARK_BAR_HEIGHT }}
    >
      {/* 左侧：账号 chip 列表（横向滚动但隐藏滚动条） + 「＋」 */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {accounts.map((account) => (
          <AccountChip
            key={account.id}
            account={account}
            active={account.id === active}
            opened={opened.includes(account.id)}
            menuPinned={pinnedMenuId === account.id}
            onOpen={openAccount}
            onTogglePinned={togglePinned}
            onRename={(a) => void renameAccount(a)}
            onRemove={(a) => void removeAccount(a)}
          />
        ))}
        <button
          type="button"
          className={iconButtonClass}
          title="添加账号"
          disabled={busy}
          onClick={() => void addAccount()}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* 右侧：当前账号页面的导航 / 调试按钮 */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className={cn(iconButtonClass, docked && 'text-primary')}
          title={docked ? '已吸附在主窗口右侧（点击取消）' : '吸附到主窗口右侧'}
          aria-pressed={docked}
          onClick={toggleDock}
        >
          {docked ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRightOpen className="h-4 w-4" />
          )}
        </button>
        {NAV_ACTIONS.map(({ action, title, icon: Icon }) => (
          <button
            key={action}
            type="button"
            className={iconButtonClass}
            title={title}
            disabled={!hasActive}
            onClick={() => runAction(action, title)}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </div>
  );
}
