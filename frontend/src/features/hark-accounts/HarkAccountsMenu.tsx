import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cable, Plus, Trash2, UserRound } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import {
  loadBrowserPrefs,
  useBrowserPrefs,
} from '@/features/host-browser/browserPrefsStore';
import {
  addHarkAccount,
  harkAccountName,
  harkAccountsFrom,
  openHarkAccount,
  removeHarkAccount,
} from './harkAccounts';
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

/** Activity-rail button listing Hark accounts; each opens hark.com in its own profile. */
export function HarkAccountsMenu() {
  const { settings } = useBrowserPrefs();
  const accounts = harkAccountsFrom(settings.profiles);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void loadBrowserPrefs().catch(() => {});
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      const created = await addHarkAccount();
      await openHarkAccount(created);
    } catch (error) {
      toast.error(`添加 Hark 账号失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const openAccount = (profile: (typeof accounts)[number]) => {
    void openHarkAccount(profile).catch((error) =>
      toast.error(`打开 Hark 账号失败：${String(error)}`)
    );
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
      <DropdownMenuContent side="right" align="start" className="min-w-[200px]">
        <DropdownMenuLabel>Hark 账号</DropdownMenuLabel>
        {accounts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs opacity-60">
            还没有账号，点下面添加一个
          </div>
        ) : null}
        {accounts.map((profile) => (
          <DropdownMenuSub key={profile.id}>
            <DropdownMenuSubTrigger onClick={() => openAccount(profile)}>
              <UserRound className="mr-2 h-3.5 w-3.5" />
              {harkAccountName(profile)}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => openAccount(profile)}>
                打开
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openBridgeSettings(profile.id)}>
                <Cable className="mr-2 h-3.5 w-3.5" />
                连接文件桥
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void removeHarkAccount(profile.id).catch((error) =>
                    toast.error(`删除失败：${String(error)}`)
                  );
                }}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                删除（清除该账号登录数据）
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={() => void add()}>
          <Plus className="mr-2 h-3.5 w-3.5" />
          添加 Hark 账号
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
