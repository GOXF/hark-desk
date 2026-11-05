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
  await loadBrowserPrefs();
  const existing = harkAccountsFrom(getBrowserPrefsSnapshot().settings.profiles);
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

export function openHarkAccount(profile: BrowserProfileRecord): boolean {
  return requestBrowserTabOpen({
    url: HARK_HOME_URL,
    profileId: profile.id,
    title: `Hark · ${harkAccountName(profile)}`,
  });
}
