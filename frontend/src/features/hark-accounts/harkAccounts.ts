// Hark accounts: each account is an isolated host-browser profile (its own
// WebView2 user-data folder on Windows), so several Hark logins can stay
// signed in side by side without sharing cookies.
import { backendCall } from '@/lib/backendTransport';
import {
  type BrowserProfileRecord,
  dispatchHostBrowser,
  getBrowserPrefsSnapshot,
  loadBrowserPrefs,
  removeBrowserProfile,
  resolveHostBrowserPluginId,
} from '@/features/host-browser/browserPrefsStore';
import { requestBrowserTabOpen } from '@/features/host-browser/openBrowserTab';
import {
  isMonorepoPluginModuleLoaded,
  syncMonorepoPluginRuntime,
} from '@/features/plugins/monorepoPluginBootstrap';
import { clearPluginCrashState } from '@/components/plugins/PluginBoundary';
import { pluginControlApi } from '@/lib/api/plugins';

const BROWSER_PLUGIN_ID = 'vibex.browser';

let ensureInFlight: Promise<string> | null = null;
let ensuredThisSession = false;

/**
 * Hark accounts live inside the built-in browser plugin. Mirror the Plugins
 * page activation (activateInstalledPlugin) instead of only flipping a flag:
 *  1. install it from the official package when missing;
 *  2. call setEnabled(true) once per session even if it already looks
 *     enabled — the backend then installs declared runtimes, provisions the
 *     pinned Node worker runtime and (re)mounts the worker in the shared Node
 *     process. It is a no-op when the worker is already live, and it repairs
 *     a stale activation whose shared Node process went away (the
 *     "Shared Node worker process is not running" page);
 *  3. load the plugin's frontend runtime (syncMonorepoPluginRuntime), which
 *     registers the browser services/commands the tab surface relies on.
 */
export function ensureHostBrowserPlugin(): Promise<string> {
  if (!ensureInFlight) {
    ensureInFlight = activateHostBrowserPlugin().catch((error: unknown) => {
      ensureInFlight = null;
      throw error;
    });
  }
  return ensureInFlight;
}

async function activateHostBrowserPlugin(): Promise<string> {
  const catalog = await pluginControlApi.catalog();
  let plugin = catalog.plugins.find((p) => p.id === BROWSER_PLUGIN_ID);
  if (!plugin) {
    plugin = await pluginControlApi.marketplaceInstall('vibex', 'browser');
  }
  if (!ensuredThisSession || !plugin.enabled || plugin.quarantined) {
    clearPluginCrashState(plugin.id);
    await pluginControlApi.setEnabled(plugin.id, true);
    ensuredThisSession = true;
  }
  if (!isMonorepoPluginModuleLoaded(plugin.id)) {
    await syncMonorepoPluginRuntime(plugin.id, true);
  }
  const pluginId = await resolveHostBrowserPluginId();
  if (!pluginId) {
    throw new Error('内置浏览器插件启用失败，请在「插件」页手动启用 Browser');
  }
  return pluginId;
}

export const HARK_HOME_URL = 'https://hark.com/';
export const HARK_PROFILE_PREFIX = 'hark-';
const LABEL_PREFIX = 'Hark · ';

export function isHarkProfileId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(HARK_PROFILE_PREFIX);
}

export function harkAccountsFrom(
  profiles: readonly BrowserProfileRecord[]
): BrowserProfileRecord[] {
  return profiles.filter((p) => isHarkProfileId(p.id));
}

export function harkAccountName(profile: BrowserProfileRecord): string {
  return profile.label.startsWith(LABEL_PREFIX)
    ? profile.label.slice(LABEL_PREFIX.length)
    : profile.label;
}

async function persistConfig(): Promise<void> {
  const pluginId = await resolveHostBrowserPluginId();
  if (!pluginId) return;
  await backendCall('plugin_save_config', {
    pluginId,
    config: getBrowserPrefsSnapshot().settings as unknown as Record<
      string,
      unknown
    >,
  }).catch(() => {});
}

export async function addHarkAccount(
  name?: string
): Promise<BrowserProfileRecord> {
  await ensureHostBrowserPlugin();
  await loadBrowserPrefs();
  const existing = harkAccountsFrom(
    getBrowserPrefsSnapshot().settings.profiles
  );
  const label = `${LABEL_PREFIX}${name?.trim() || `账号 ${existing.length + 1}`}`;
  const id = `${HARK_PROFILE_PREFIX}${Date.now().toString(36)}`;
  const created = await dispatchHostBrowser<BrowserProfileRecord>(
    'profile.create',
    { id, label }
  );
  await loadBrowserPrefs();
  await persistConfig();
  return created;
}

export async function removeHarkAccount(profileId: string): Promise<void> {
  if (!isHarkProfileId(profileId)) return;
  await removeBrowserProfile(profileId);
}

export async function openHarkAccount(
  profile: BrowserProfileRecord
): Promise<boolean> {
  await ensureHostBrowserPlugin();
  return requestBrowserTabOpen({
    url: HARK_HOME_URL,
    profileId: profile.id,
    title: `Hark · ${harkAccountName(profile)}`,
  });
}
