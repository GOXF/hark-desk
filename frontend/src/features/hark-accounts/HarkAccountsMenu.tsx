import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cable, Pencil, Plus, Trash2, UserRound } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import {
  getHarkOpenMode,
  harkWindowApi,
  setHarkOpenMode,
  useHarkAccounts,
  type HarkAccount,
  type HarkOpenMode,
} from './harkWindowApi';
import { HARK_BRIDGE_SETTINGS_PATH } from '@/features/hark-bridge/harkBridgeApi';
import { openSettingsSurface } from '@/lib/api/settingsWindow';

function HarkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path
        d="M4 2.5v11M12 2.5v11M4 8h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 活动栏的 Hark 按钮。账号由宿主直接用 WebView2 打开（每账号独立数据目录，
 * 不经过内置浏览器插件），见 src-tauri/src/hark_window.rs。
 */
export function HarkAccountsMenu() {
  const { accounts, opened } = useHarkAccounts();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<HarkOpenMode>(getHarkOpenMode);
  const navigate = useNavigate();

  const openAccount = async (id: string) => {
    if (mode === 'tab') {
      toast.info('「嵌入标签页」还在做，先用独立窗口打开');
    }
    try {
      await harkWindowApi.open(id);
    } catch (error) {
      toast.error(`打开 Hark 账号失败：${errorText(error)}`);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      const created = await harkWindowApi.add();
      await harkWindowApi.open(created.id);
      toast.success(`已添加 ${created.name}，请在 Hark 窗口里登录`);
    } catch (error) {
      toast.error(`添加 Hark 账号失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (account: HarkAccount) => {
    const name = window.prompt('账号名字', account.name)?.trim();
    if (!name || name === account.name) return;
    await harkWindowApi
      .rename(account.id, name)
      .catch((error) => toast.error(`重命名失败：${errorText(error)}`));
  };

  const remove = async (account: HarkAccount) => {
    if (!window.confirm(`删除「${account.name}」会清除该账号的登录数据，确定吗？`)) {
      return;
    }
    await harkWindowApi
      .remove(account.id)
      .catch((error) => toast.error(`删除失败：${errorText(error)}`));
  };

  const changeMode = (value: string) => {
    const next: HarkOpenMode = value === 'tab' ? 'tab' : 'window';
    setMode(next);
    setHarkOpenMode(next);
  };

  const openBridgeSettings = (profileId: string) => {
    openSettingsSurface(
      navigate,
      `${HARK_BRIDGE_SETTINGS_PATH}?profile=${encodeURIComponent(profileId)}`
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Hark 账号"
          aria-label="Hark 账号"
          className="workspace-side-rail-button flex h-7 w-7 items-center justify-center"
        >
          <HarkMark className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="min-w-[220px]">
        <DropdownMenuLabel>Hark 账号</DropdownMenuLabel>
        {accounts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs opacity-60">
            还没有账号，点下面添加一个
          </div>
        ) : null}
        {accounts.map((account) => (
          <DropdownMenuSub key={account.id}>
            <DropdownMenuSubTrigger onClick={() => void openAccount(account.id)}>
              <UserRound className="mr-2 h-3.5 w-3.5" />
              <span className="flex-1 truncate">{account.name}</span>
              {opened.includes(account.id) ? (
                <span
                  className="ml-2 h-1.5 w-1.5 rounded-full bg-green-500"
                  title="已打开"
                />
              ) : null}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void openAccount(account.id)}>
                打开
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void rename(account)}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openBridgeSettings(account.id)}>
                <Cable className="mr-2 h-3.5 w-3.5" />
                连接文件桥
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void remove(account)}>
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                删除（清除该账号登录数据）
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        <DropdownMenuItem disabled={busy} onSelect={() => void add()}>
          <Plus className="mr-2 h-3.5 w-3.5" />
          添加 Hark 账号
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal opacity-60">
          打开方式
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={changeMode}>
          <DropdownMenuRadioItem value="window">独立窗口</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="tab" disabled>
            嵌入标签页（即将推出）
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
