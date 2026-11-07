import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Cable,
  Copy,
  FolderOpen,
  FolderPlus,
  Link2,
  Network,
  Play,
  ScrollText,
  ShieldQuestion,
  Send,
  Square,
  Star,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  loadBrowserPrefs,
  useBrowserPrefs,
} from '@/features/host-browser/browserPrefsStore';
import {
  harkAccountName,
  harkAccountsFrom,
} from '@/features/hark-accounts/harkAccounts';
import {
  errorText,
  harkBridgeApi,
  useHarkBridgeState,
} from '@/features/hark-bridge/harkBridgeApi';
import type {
  HarkBridgeConfirmAnswer,
  HarkBridgeExecMode,
  HarkBridgeItem,
  HarkBridgeState,
  HarkBridgeTunnelMode,
} from '@/features/hark-bridge/types';
import { useTauriClient } from '@/lib/desktopShell';
import { cn } from '@/lib/utils';

import { SettingsSection } from './SettingsUi';

const TUNNEL_MODES: { value: HarkBridgeTunnelMode; label: string }[] = [
  { value: 'ngrok', label: '固定（ngrok）' },
  { value: 'custom', label: '自己的域名' },
  { value: 'cloudflare', label: '临时（Cloudflare）' },
];

const EXEC_LABELS: Record<HarkBridgeExecMode, string> = {
  confirm: '每次执行前问我',
  auto: '一直允许',
  off: '不允许',
};

const NO_BRIDGE = '__none__';

type Tone = 'ok' | 'warn' | 'err' | 'muted';

function StatusChip({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-normal',
        tone === 'muted' && 'text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          tone === 'ok' && 'bg-emerald-500',
          tone === 'warn' && 'bg-amber-500',
          tone === 'err' && 'bg-red-500',
          tone === 'muted' && 'bg-muted-foreground/50'
        )}
      />
      {children}
    </span>
  );
}

function CodeText({ children }: { children: string }) {
  return (
    <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">
      {children}
    </code>
  );
}

function tunnelChip(state: HarkBridgeState): { tone: Tone; label: string } {
  const t = state.tunnel;
  if (t.url && t.status !== 'stopped') {
    return t.fixed
      ? { tone: 'ok', label: '固定地址' }
      : { tone: 'warn', label: '临时地址（重启会变）' };
  }
  if (t.status === 'starting') return { tone: 'warn', label: '连接中…' };
  return { tone: 'err', label: '未上线' };
}

function bridgeChip(b: HarkBridgeItem): { tone: Tone; label: string } {
  if (b.online) return { tone: 'ok', label: '在线' };
  if (b.err) return { tone: 'err', label: '出错' };
  if (b.status === 'starting') return { tone: 'warn', label: '启动中…' };
  if (b.status === 'stopped') return { tone: 'muted', label: '已停止' };
  if (b.status === 'running' || b.status === 'no-tunnel')
    return { tone: 'warn', label: '运行中，等待通道' };
  return { tone: 'muted', label: b.status || '未知' };
}

async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === 'string' ? selected : null;
}

async function run(
  action: () => Promise<unknown>,
  failPrefix: string,
  success?: string
): Promise<boolean> {
  try {
    await action();
    if (success) toast.success(success);
    return true;
  } catch (error) {
    toast.error(`${failPrefix}：${errorText(error)}`);
    return false;
  }
}

// ───────────────────────── 通道 ─────────────────────────

interface TunnelDraft {
  mode?: HarkBridgeTunnelMode;
  ngrokDomain?: string;
  ngrokToken?: string;
  customUrl?: string;
  useProxy?: boolean;
}

function TunnelSection({ state }: { state: HarkBridgeState }) {
  const t = state.tunnel;
  // 未保存的输入单独记着；后台推送新状态重画时不会被冲掉。
  const [draft, setDraft] = useState<TunnelDraft>({});
  const [saving, setSaving] = useState(false);
  const mode: HarkBridgeTunnelMode = draft.mode ?? t.mode ?? 'cloudflare';
  const ngrokDomain = draft.ngrokDomain ?? t.ngrokDomain ?? '';
  const customUrl = draft.customUrl ?? t.customUrl ?? '';
  const useProxy = draft.useProxy ?? t.useProxy;
  const chip = tunnelChip(state);
  const portText = t.port ? String(t.port) : '<端口>（启动后显示）';

  const save = async () => {
    if (mode === 'custom' && !customUrl.trim()) {
      toast.error('先填你的地址');
      return;
    }
    if (mode === 'ngrok' && !ngrokDomain.trim()) {
      toast.error('先填 ngrok 域名');
      return;
    }
    setSaving(true);
    const ok = await run(
      () =>
        harkBridgeApi.saveTunnel({
          mode,
          ngrokDomain: mode === 'ngrok' ? ngrokDomain.trim() : undefined,
          ngrokToken:
            mode === 'ngrok' && draft.ngrokToken?.trim()
              ? draft.ngrokToken.trim()
              : undefined,
          customUrl: mode === 'custom' ? customUrl.trim() : undefined,
          useProxy,
        }),
      '保存失败',
      '已保存，正在重连…'
    );
    setSaving(false);
    if (ok) setDraft({});
  };

  const clearToken = async () => {
    if (!window.confirm('清除已保存的 ngrok authtoken？')) return;
    await run(
      () =>
        harkBridgeApi.saveTunnel({
          mode,
          ngrokDomain: mode === 'ngrok' ? ngrokDomain.trim() : undefined,
          clearToken: true,
          customUrl: mode === 'custom' ? customUrl.trim() : undefined,
        }),
      '清除失败',
      '已清除 authtoken'
    );
  };

  return (
    <SettingsSection
      icon={Network}
      title="通道"
      description="所有文件桥默认共用一个通道地址，按路径区分（地址/mcp/桥名）。固定地址重启不变，只需告诉 Hark 一次。"
      action={<StatusChip tone={chip.tone}>{chip.label}</StatusChip>}
    >
      <div className="space-y-4">
        <div className="settings-row">
          <div>
            <Label>连接方式</Label>
            <p className="settings-row__description">
              固定地址重启不变；临时地址每次重启都会变。
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="连接方式"
            className="inline-flex flex-wrap gap-1 rounded-md border p-0.5"
          >
            {TUNNEL_MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={mode === item.value}
                className={cn(
                  'rounded px-2.5 py-1 text-xs transition-colors',
                  mode === item.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                )}
                onClick={() => setDraft((d) => ({ ...d, mode: item.value }))}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'ngrok' ? (
          <>
            <div className="settings-row">
              <div>
                <Label htmlFor="hb-ngrok-domain">ngrok 域名</Label>
                <p className="settings-row__description">
                  ngrok 控制台 → Domains
                </p>
              </div>
              <Input
                id="hb-ngrok-domain"
                className="w-72"
                placeholder="xxx.ngrok-free.dev"
                value={ngrokDomain}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, ngrokDomain: e.target.value }))
                }
              />
            </div>
            <div className="settings-row">
              <div>
                <Label htmlFor="hb-ngrok-token">authtoken</Label>
                <p className="settings-row__description">
                  {t.hasNgrokToken
                    ? '已加密保存，要更换就粘贴新的'
                    : 'ngrok 控制台 → Your Authtoken'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="hb-ngrok-token"
                  type="password"
                  autoComplete="off"
                  className="w-56"
                  placeholder={
                    t.hasNgrokToken ? '••••••••（已保存）' : '粘贴 authtoken'
                  }
                  value={draft.ngrokToken ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, ngrokToken: e.target.value }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!t.hasNgrokToken}
                  onClick={() => void clearToken()}
                >
                  清除
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {mode === 'custom' ? (
          <div className="settings-row settings-row--stacked">
            <div className="settings-row__stack">
              <Label htmlFor="hb-custom-url">你的地址</Label>
              <p className="settings-row__description">
                你自己服务器上的域名（比如用 Caddy 反向代理）。
              </p>
            </div>
            <Input
              id="hb-custom-url"
              placeholder="https://bridge.example.com"
              value={customUrl}
              onChange={(e) =>
                setDraft((d) => ({ ...d, customUrl: e.target.value }))
              }
            />
            <p className="text-xs leading-5 text-muted-foreground">
              把这个域名反向代理到本机{' '}
              <CodeText>{`http://127.0.0.1:${portText}`}</CodeText>，Hark
              用的地址是 <CodeText>你的地址/mcp</CodeText>，其他桥是{' '}
              <CodeText>/mcp/桥名</CodeText>。此模式下不再开 ngrok 或
              Cloudflare。
            </p>
          </div>
        ) : null}

        {mode === 'cloudflare' ? (
          <p className="text-xs leading-5 text-muted-foreground">
            使用 Cloudflare 临时通道，无需配置；地址每次重启都会变，需要重新发给
            Hark。
          </p>
        ) : null}

        <div className="settings-row">
          <div>
            <Label>主桥走全局代理</Label>
            <p className="settings-row__description">
              关闭后主桥直连；保存后生效。
            </p>
          </div>
          <Switch
            checked={useProxy}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, useProxy: v }))}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="min-w-0 text-xs text-muted-foreground">
            {t.url ? (
              <>
                当前地址：<CodeText>{t.url}</CodeText>
              </>
            ) : (
              '通道未上线'
            )}
            {t.err ? (
              <div className="mt-1 break-all text-red-500">{t.err}</div>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '正在重连…' : '保存并重连'}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

// ───────────────────────── 单条桥 ─────────────────────────

function BridgeCard({
  bridge,
  isDefault,
}: {
  bridge: HarkBridgeItem;
  isDefault: boolean;
}) {
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [pubDraft, setPubDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const chip = bridgeChip(bridge);

  const toggleLogs = async () => {
    if (logs) {
      setLogs(null);
      return;
    }
    try {
      setLogs(await harkBridgeApi.logs(bridge.id));
    } catch (error) {
      toast.error(`读取日志失败：${errorText(error)}`);
    }
  };
  const stopped =
    bridge.stopped || bridge.status === 'stopped' || bridge.status === 'error';

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const patch = (p: Parameters<typeof harkBridgeApi.update>[1]) =>
    run(() => harkBridgeApi.update(bridge.id, p), '保存失败');

  const commitName = async () => {
    if (nameDraft === null) return;
    const next = nameDraft.trim();
    if (!next || next === bridge.name) {
      setNameDraft(null);
      return;
    }
    if (await patch({ name: next })) setNameDraft(null);
  };

  const changeFolder = async () => {
    try {
      const folder = await pickFolder('选择共享文件夹');
      if (folder) await patch({ folder });
    } catch (error) {
      toast.error(`选择文件夹失败：${errorText(error)}`);
    }
  };

  const savePublicUrl = async () => {
    if (pubDraft === null) return;
    if (await patch({ publicUrl: pubDraft.trim() })) setPubDraft(null);
  };

  const copyMessage = async () => {
    try {
      const message = await harkBridgeApi.connectMessage(bridge.id);
      await navigator.clipboard.writeText(message);
      toast.success('已复制连接消息，粘贴到 Hark 聊天即可');
    } catch (error) {
      toast.error(`复制失败：${errorText(error)}`);
    }
  };

  const toggleRunning = async () => {
    setBusy(true);
    await run(
      () =>
        stopped
          ? harkBridgeApi.start(bridge.id)
          : harkBridgeApi.stop(bridge.id),
      stopped ? '启动失败' : '停止失败'
    );
    setBusy(false);
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    await run(() => harkBridgeApi.remove(bridge.id), '删除失败', '已删除');
  };

  return (
    <div className="space-y-3 border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input
          aria-label="桥名"
          className="h-8 w-56 font-medium"
          value={nameDraft ?? bridge.name}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitName();
            if (e.key === 'Escape') setNameDraft(null);
          }}
        />
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
        {bridge.isMain ? <StatusChip tone="muted">主桥</StatusChip> : null}
        {isDefault ? <StatusChip tone="muted">默认</StatusChip> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void toggleRunning()}
          >
            {stopped ? (
              <Play className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Square className="mr-1 h-3.5 w-3.5" />
            )}
            {stopped ? '启动' : '停止'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void toggleLogs()}
          >
            <ScrollText className="mr-1 h-3.5 w-3.5" />
            {logs ? '收起日志' : '日志'}
          </Button>
          {bridge.isMain ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(confirmDelete && 'text-red-500')}
              onClick={() => void remove()}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {confirmDelete ? '再点一次确认删除' : '删除'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-sm">
        <span className="text-xs text-muted-foreground">地址</span>
        <div className="min-w-0">
          {bridge.url ? (
            <CodeText>{bridge.url}</CodeText>
          ) : (
            <span className="text-xs text-muted-foreground">
              {bridge.isMain
                ? '上线后显示'
                : `…/mcp/${bridge.id}（上线后显示）`}
            </span>
          )}
        </div>

        <span className="text-xs text-muted-foreground">共享文件夹</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CodeText>{bridge.folder || '未选择'}</CodeText>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void changeFolder()}
          >
            更换
          </Button>
        </div>

        <span className="text-xs text-muted-foreground">权限</span>
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2 text-xs">
            <Switch
              checked={bridge.readonly}
              onCheckedChange={(v) => void patch({ readonly: v })}
            />
            只读
          </label>
          <label className="inline-flex items-center gap-2 text-xs">
            <Switch
              checked={bridge.allowDelete}
              disabled={bridge.readonly}
              onCheckedChange={(v) => void patch({ allowDelete: v })}
            />
            允许删除文件
          </label>
        </div>

        <span className="text-xs text-muted-foreground">执行命令</span>
        <div>
          <Select
            value={bridge.execMode}
            onValueChange={(v) =>
              void patch({ execMode: v as HarkBridgeExecMode })
            }
          >
            <SelectTrigger className="h-8 w-48" aria-label="执行命令">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {(Object.keys(EXEC_LABELS) as HarkBridgeExecMode[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {EXEC_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {bridge.isMain ? null : (
          <>
            <span className="text-xs text-muted-foreground">单独地址</span>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-8 min-w-[16rem] flex-1"
                  placeholder={`留空 = 走主通道 …/mcp/${bridge.id}`}
                  value={pubDraft ?? bridge.publicUrl}
                  onChange={(e) => setPubDraft(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pubDraft === null}
                  onClick={() => void savePublicUrl()}
                >
                  保存
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {bridge.publicUrl ? (
                  <>
                    这条桥走你自己的地址，把它反代到本机{' '}
                    <CodeText>{`http://127.0.0.1:${bridge.port ?? '（启动后显示）'}`}</CodeText>
                  </>
                ) : (
                  '不填就跟主通道走，不用单独配置。'
                )}
              </p>
            </div>
          </>
        )}

        {bridge.err ? (
          <>
            <span />
            <div className="break-all text-xs text-red-500">{bridge.err}</div>
          </>
        ) : null}
      </div>

      {logs ? (
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs leading-5">
          {logs.length ? logs.join('\n') : '（暂无）'}
        </pre>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!bridge.online}
          title={bridge.online ? undefined : '桥上线后才能复制'}
          onClick={() => void copyMessage()}
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          复制连接消息
        </Button>
      </div>
    </div>
  );
}

function NewBridgeForm() {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    try {
      const picked = await pickFolder('选择要共享的文件夹');
      if (picked) {
        setFolder(picked);
        if (!name.trim()) {
          const base = picked.split(/[\\/]/).filter(Boolean).pop();
          if (base) setName(base);
        }
      }
    } catch (error) {
      toast.error(`选择文件夹失败：${errorText(error)}`);
    }
  };

  const create = async () => {
    if (!name.trim()) {
      toast.error('先填桥名');
      return;
    }
    if (!folder) {
      toast.error('先选择共享文件夹');
      return;
    }
    setBusy(true);
    const ok = await run(
      () => harkBridgeApi.create(name.trim(), folder),
      '新建失败',
      '已新建文件桥'
    );
    setBusy(false);
    if (ok) {
      setName('');
      setFolder('');
    }
  };

  return (
    <div className="space-y-3 p-4">
      <div className="settings-row">
        <div>
          <Label htmlFor="hb-new-name">桥名</Label>
          <p className="settings-row__description">
            显示用的名字，比如「店铺文件」
          </p>
        </div>
        <Input
          id="hb-new-name"
          className="w-64"
          placeholder="如：店铺文件"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="settings-row">
        <div>
          <Label>共享文件夹</Label>
          <p className="settings-row__description break-all">
            {folder || '未选择'}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void choose()}
        >
          选择…
        </Button>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void create()}
        >
          <FolderPlus className="mr-1 h-3.5 w-3.5" />
          新建并启动
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── 账号绑定 ─────────────────────────

interface BindingDraft {
  bridgeId?: string;
  projectUrl?: string;
}

function AccountBindingRow({
  profileId,
  name,
  state,
  highlighted,
}: {
  profileId: string;
  name: string;
  state: HarkBridgeState;
  highlighted: boolean;
}) {
  const saved = state.bindings.find((b) => b.profileId === profileId);
  const [draft, setDraft] = useState<BindingDraft>({});
  const [busy, setBusy] = useState(false);
  const defaultBridge = state.bridges.find((b) => b.id === state.defaultBridge);
  const defaultName = defaultBridge
    ? defaultBridge.name || defaultBridge.id
    : '未设置';
  const bridgeId = draft.bridgeId ?? saved?.bridgeId ?? NO_BRIDGE;
  const projectUrl = draft.projectUrl ?? saved?.projectUrl ?? '';
  const dirty =
    (draft.bridgeId !== undefined &&
      draft.bridgeId !== (saved?.bridgeId ?? NO_BRIDGE)) ||
    (draft.projectUrl !== undefined &&
      draft.projectUrl !== (saved?.projectUrl ?? ''));

  const persist = async (): Promise<boolean> => {
    const url = projectUrl.trim();
    if (url && !/^https?:\/\/([a-z0-9-]+\.)*hark\.com\//i.test(url)) {
      toast.error(
        '项目地址应是 hark.com 的项目链接，例如 https://hark.com/project/…'
      );
      return false;
    }
    if (bridgeId === NO_BRIDGE) {
      if (url) {
        // 填了项目地址：按默认桥绑定，消息才会发到这个项目。
        const def = state.defaultBridge;
        if (!def) {
          toast.error('还没有默认文件桥，请先选一条桥');
          return false;
        }
        return run(() => harkBridgeApi.bind(profileId, def, url), '绑定失败');
      }
      if (!saved) return true;
      return run(() => harkBridgeApi.unbind(profileId), '解除绑定失败');
    }
    return run(() => harkBridgeApi.bind(profileId, bridgeId, url), '绑定失败');
  };

  const save = async () => {
    setBusy(true);
    if (await persist()) {
      setDraft({});
      toast.success('已保存');
    }
    setBusy(false);
  };

  const sendNow = async () => {
    setBusy(true);
    if (dirty && !(await persist())) {
      setBusy(false);
      return;
    }
    setDraft({});
    await run(
      () => harkBridgeApi.send(profileId),
      '发送失败',
      '已发送连接消息到 Hark'
    );
    setBusy(false);
  };

  return (
    <div
      id={`hark-bridge-account-${profileId}`}
      className={cn(
        'space-y-2 border-b p-4 last:border-b-0',
        highlighted && 'bg-muted/50'
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{name}</span>
        {saved?.sending ? (
          <StatusChip tone="warn">发送中…</StatusChip>
        ) : saved?.sendErr ? (
          <StatusChip tone="err">发送失败</StatusChip>
        ) : saved?.sentUrl ? (
          <StatusChip tone="ok">已发送</StatusChip>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={bridgeId}
          onValueChange={(v) => setDraft((d) => ({ ...d, bridgeId: v }))}
        >
          <SelectTrigger className="h-8 w-48" aria-label="文件桥">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={NO_BRIDGE}>
              {`跟随默认（${defaultName}）`}
            </SelectItem>
            {state.bridges.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name || b.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Hark 项目地址"
          className="h-8 min-w-[16rem] flex-1"
          placeholder="项目地址，例如 https://hark.com/project/…（留空发到当前聊天）"
          value={projectUrl}
          onChange={(e) =>
            setDraft((d) => ({ ...d, projectUrl: e.target.value }))
          }
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          保存
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || saved?.sending}
          onClick={() => void sendNow()}
        >
          <Send className="mr-1 h-3.5 w-3.5" />
          立即发送
        </Button>
      </div>
      {saved?.sendErr ? (
        <p className="break-all text-xs text-red-500">{saved.sendErr}</p>
      ) : saved?.sentUrl ? (
        <p className="break-all text-xs text-muted-foreground">
          上次发送的地址：{saved.sentUrl}
        </p>
      ) : null}
    </div>
  );
}

function AccountBindingsSection({ state }: { state: HarkBridgeState }) {
  const { settings } = useBrowserPrefs();
  const accounts = harkAccountsFrom(settings.profiles);
  const [searchParams] = useSearchParams();
  const focusProfile = searchParams.get('profile');

  useEffect(() => {
    void loadBrowserPrefs().catch(() => {});
  }, []);

  useEffect(() => {
    if (!focusProfile) return;
    const el = document.getElementById(`hark-bridge-account-${focusProfile}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusProfile, accounts.length]);

  return (
    <SettingsSection
      icon={Link2}
      title="Hark 账号绑定"
      description="给每个 Hark 账号选一条文件桥，并填入 hark.com 的项目地址。保存后桥在线时会自动发一次连接消息；「立即发送」手动再发（未填项目地址则发到当前聊天）。"
    >
      {accounts.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          还没有 Hark 账号。在左侧栏的 Hark 账号菜单里添加一个。
        </div>
      ) : (
        accounts.map((profile) => (
          <AccountBindingRow
            key={profile.id}
            profileId={profile.id}
            name={harkAccountName(profile)}
            state={state}
            highlighted={profile.id === focusProfile}
          />
        ))
      )}
    </SettingsSection>
  );
}

// ───────────────────────── 命令审批 ─────────────────────────

const CONFIRM_ANSWERS: { answer: HarkBridgeConfirmAnswer; label: string }[] = [
  { answer: 'allow', label: '这一次允许' },
  { answer: 'always', label: '一直允许' },
  { answer: 'deny', label: '这一次拒绝' },
  { answer: 'never', label: '拒绝并关闭' },
];

function ConfirmsSection({ state }: { state: HarkBridgeState }) {
  if (state.confirms.length === 0) return null;
  const nameOf = (id: string) =>
    state.bridges.find((b) => b.id === id)?.name || id;
  return (
    <SettingsSection
      icon={ShieldQuestion}
      title="待审批的命令"
      description="Hark 请求在这台电脑上执行命令；120 秒内不回复会自动拒绝。"
    >
      {state.confirms.map((c) => (
        <div
          key={`${c.bridgeId}:${c.reqId}`}
          className="space-y-2 border-b p-4 last:border-b-0"
        >
          <div className="text-xs text-muted-foreground">
            {`文件桥「${nameOf(c.bridgeId)}」 · ${c.kind}${c.cwd ? ` · ${c.cwd}` : ''}`}
          </div>
          <pre className="overflow-auto rounded bg-muted p-2 text-xs">
            {c.command}
          </pre>
          <div className="flex flex-wrap gap-2">
            {CONFIRM_ANSWERS.map((item) => (
              <Button
                key={item.answer}
                type="button"
                size="sm"
                variant={item.answer === 'allow' ? 'default' : 'outline'}
                onClick={() =>
                  void run(
                    () =>
                      harkBridgeApi.confirm(c.bridgeId, c.reqId, item.answer),
                    '回复失败'
                  )
                }
              >
                {item.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

// ───────────────────────── 页面 ─────────────────────────

function DefaultBridgeSection({ state }: { state: HarkBridgeState }) {
  const value = state.defaultBridge || NO_BRIDGE;
  return (
    <SettingsSection
      icon={Star}
      title="默认文件桥"
      description="账号没有单独绑定时用这条桥。"
    >
      <div className="settings-row">
        <div>
          <Label>默认文件桥</Label>
        </div>
        <Select
          value={value}
          onValueChange={(v) => {
            if (v === NO_BRIDGE) return;
            void run(() => harkBridgeApi.setDefault(v), '设置默认失败');
          }}
        >
          <SelectTrigger className="w-56" aria-label="默认文件桥">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {state.defaultBridge ? null : (
              <SelectItem value={NO_BRIDGE}>未设置</SelectItem>
            )}
            {state.bridges.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name || b.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SettingsSection>
  );
}

export function HarkBridgeSettings() {
  const isTauri = useTauriClient();
  const { state, loadError, refresh } = useHarkBridgeState(isTauri);

  const bridges = useMemo(() => state?.bridges ?? [], [state]);

  if (!isTauri) {
    return (
      <div className="settings-content">
        <div className="settings-sections">
          <SettingsSection icon={Cable} title="文件桥">
            <div className="p-4 text-sm text-muted-foreground">
              仅桌面版可用。请在 Hark Desk 桌面客户端里打开此页面。
            </div>
          </SettingsSection>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="settings-content">
        <div className="settings-sections">
          <SettingsSection icon={Cable} title="文件桥">
            <div className="flex items-center justify-between gap-3 p-4 text-sm text-muted-foreground">
              <span className="break-all">
                {loadError ? `读取文件桥状态失败：${loadError}` : '正在读取…'}
              </span>
              {loadError ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                >
                  重试
                </Button>
              ) : null}
            </div>
          </SettingsSection>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-content">
      <div className="settings-sections">
        {state.bridgeExeFound ? null : (
          <div className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-600">
            安装包里没找到 HarkBridge 程序，文件桥无法启动。请重新安装最新版
            Hark Desk。
          </div>
        )}
        <ConfirmsSection state={state} />
        <TunnelSection state={state} />
        <DefaultBridgeSection state={state} />
        <SettingsSection
          icon={Cable}
          title={`全部文件桥（${bridges.length}）`}
          description="每个文件桥共享一个文件夹，有自己的密钥和权限，彼此看不到对方的文件。"
        >
          {bridges.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">
              还没有文件桥，在下面新建一个。
            </div>
          ) : (
            bridges.map((b) => (
              <BridgeCard
                key={b.id}
                bridge={b}
                isDefault={b.id === state.defaultBridge}
              />
            ))
          )}
        </SettingsSection>
        <SettingsSection
          icon={FolderPlus}
          title="新建文件桥"
          description="选一个文件夹共享给 Hark；新建后自动启动。"
        >
          <NewBridgeForm />
        </SettingsSection>
        <AccountBindingsSection state={state} />
      </div>
    </div>
  );
}
