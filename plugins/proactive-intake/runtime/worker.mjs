import { definePluginWorker } from '@vibex/plugin-sdk/worker';

import {
  describeNotification,
  listNotifications,
  markRead,
  resolveToken,
  TOKEN_SECRET,
} from './github.mjs';
import {
  buildPrompt,
  canStart,
  classifyTurn,
  currentQuota,
  eventKey,
  gate,
  normalizeConfig,
  rememberSeen,
  sumUsage,
} from './intake.mjs';

const KEYS = {
  state: 'intake.state',
  seen: 'intake.seen',
  quota: 'intake.quota',
  active: 'intake.active',
  log: 'intake.log',
};

async function kvGet(host, key, fallback) {
  const value = await host.call('storage', 'kv.get', { key });
  return value ?? fallback;
}

async function kvPut(host, key, value) {
  await host.call('storage', 'kv.put', { key, value });
}

async function toast(host, title, message, variant = 'info') {
  try {
    await host.call('app', 'notify.toast', { title, message, variant, durationMs: 8000 });
  } catch {
    /* toast is best effort */
  }
}

async function appendLog(host, entry) {
  const log = await kvGet(host, KEYS.log, []);
  const next = [...(Array.isArray(log) ? log : []), { at: new Date().toISOString(), ...entry }];
  await kvPut(host, KEYS.log, next.slice(-100));
}

/**
 * A token typed into the settings form is moved into the OS keychain and
 * removed from config.json on the next tick, so it is never kept in plain text.
 */
async function migrateTokenFromSettings(host) {
  const settings = (await host.call('storage', 'settings.get', {})) ?? {};
  const typed = typeof settings.githubToken === 'string' ? settings.githubToken.trim() : '';
  if (!typed) return settings;
  await host.call('secrets', 'put', { key: TOKEN_SECRET, value: typed });
  const { githubToken: _drop, ...rest } = settings;
  await host.call('storage', 'settings.put', rest);
  await toast(host, '主动接活', 'GitHub token 已存入系统钥匙串，设置文件里的明文已清除。', 'success');
  return rest;
}

async function pickAgent(host, config) {
  if (config.agentId) return config.agentId;
  try {
    const catalog = await host.call('conversation', 'catalog', {});
    const agents = catalog?.agents ?? catalog?.items ?? (Array.isArray(catalog) ? catalog : []);
    const first = agents.find((a) => a?.id || a?.agentId);
    return first?.id ?? first?.agentId ?? '';
  } catch {
    return '';
  }
}

/** Checks running jobs: counts their tokens when done, alerts when a human is needed. */
async function reconcileActive(host, quota) {
  const active = await kvGet(host, KEYS.active, []);
  const still = [];
  for (const job of Array.isArray(active) ? active : []) {
    let view;
    try {
      view = await host.call('conversation', 'read.get', { conversationId: job.conversationId });
    } catch (error) {
      await appendLog(host, { kind: 'job_lost', title: job.title, error: String(error?.message ?? error) });
      continue;
    }
    const state = classifyTurn(view);
    if (state === 'running') {
      still.push(job);
      continue;
    }
    if (state === 'needs_human') {
      if (!job.alerted) {
        await toast(host, '主动接活需要你', `「${job.title}」在等你确认权限或回答问题。`, 'warning');
        job.alerted = true;
      }
      still.push(job);
      continue;
    }
    let tokens = null;
    try {
      const page = await host.call('conversation', 'events.since', {
        conversationId: job.conversationId,
        afterSequence: 0,
      });
      tokens = sumUsage(page?.rows);
    } catch {
      tokens = null;
    }
    if (tokens === null) quota.tokensUnknownRuns += 1;
    else quota.tokens += tokens;
    if (state === 'failed') {
      await toast(host, '主动接活失败', `「${job.title}」没有完成，请打开会话查看。`, 'error');
    }
    await appendLog(host, { kind: state === 'failed' ? 'job_failed' : 'job_done', title: job.title, url: job.url, tokens });
  }
  await kvPut(host, KEYS.active, still);
  return still;
}

/** One intake round. `force` skips the polling interval. */
export async function runTick(host, { force = false, now = new Date() } = {}) {
  const settings = await migrateTokenFromSettings(host);
  const config = normalizeConfig(settings);
  const state = await kvGet(host, KEYS.state, {});
  const quota = currentQuota(await kvGet(host, KEYS.quota, null), now);

  const active = await reconcileActive(host, quota);
  await kvPut(host, KEYS.quota, quota);

  if (!config.enabled) {
    await kvPut(host, KEYS.state, { ...state, lastResult: 'disabled' });
    return { polled: false, reason: 'disabled' };
  }
  const due = !state.nextPollAt || Date.parse(state.nextPollAt) <= now.getTime();
  if (!force && !due) return { polled: false, reason: 'not_due' };

  const { token, source } = await resolveToken(host);
  if (!token) {
    await kvPut(host, KEYS.state, { ...state, lastResult: 'no_token', lastPollAt: now.toISOString() });
    return { polled: false, reason: 'no_token' };
  }

  let page;
  try {
    page = await listNotifications(host, token, state.lastModified);
  } catch (error) {
    const failures = (state.failures ?? 0) + 1;
    const next = { ...state, failures, lastError: String(error?.message ?? error), lastPollAt: now.toISOString(),
      nextPollAt: new Date(now.getTime() + config.pollSeconds * 1000).toISOString() };
    await kvPut(host, KEYS.state, next);
    if (failures === 3) await toast(host, '主动接活', `连续 3 次读取 GitHub 通知失败：${next.lastError}`, 'error');
    return { polled: true, reason: 'fetch_failed' };
  }

  let seen = await kvGet(host, KEYS.seen, []);
  const outcome = { admitted: 0, refused: 0, skipped: 0, deferred: 0 };
  let running = active.length;

  for (const notification of page.notifications) {
    const event = await describeNotification(host, token, notification);
    const key = eventKey(event);
    if (seen.includes(key)) {
      outcome.skipped += 1;
      continue;
    }
    const verdict = gate(event, config);
    if (!verdict.admit) {
      seen = rememberSeen(seen, key);
      outcome.refused += 1;
      await appendLog(host, { kind: 'refused', reason: verdict.reason, repository: event.repository, sender: event.sender, title: event.title });
      continue;
    }
    const allowed = canStart(quota, config, running);
    if (!allowed.ok) {
      // Not remembered as seen: it is picked up again once the limit frees.
      outcome.deferred += 1;
      await appendLog(host, { kind: 'deferred', reason: allowed.reason, title: event.title });
      continue;
    }
    const agentId = await pickAgent(host, config);
    if (!agentId) {
      outcome.deferred += 1;
      await toast(host, '主动接活', '没有可用的 Agent，请在插件设置里填 agentId。', 'warning');
      break;
    }
    const created = await host.call('conversation', 'create', {
      agentId,
      ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
      title: `[接活] ${event.title}`.slice(0, 120),
      prompt: buildPrompt(event),
    });
    const conversationId = created?.id ?? created?.conversationId;
    seen = rememberSeen(seen, key);
    quota.runs += 1;
    running += 1;
    outcome.admitted += 1;
    const jobs = await kvGet(host, KEYS.active, []);
    jobs.push({ conversationId, title: event.title, url: event.url, startedAt: now.toISOString(), alerted: false });
    await kvPut(host, KEYS.active, jobs);
    await appendLog(host, { kind: 'admitted', title: event.title, url: event.url, sender: event.sender, conversationId });
    if (config.markRead) {
      try {
        await markRead(host, token, event.id);
      } catch {
        /* marking read is optional */
      }
    }
  }

  await kvPut(host, KEYS.seen, seen);
  await kvPut(host, KEYS.quota, quota);
  const interval = Math.max(config.pollSeconds, page.pollInterval || 60);
  await kvPut(host, KEYS.state, {
    // With deferred work, keep the old Last-Modified so the next poll lists it again.
    lastModified: outcome.deferred > 0 ? state.lastModified : page.lastModified,
    lastPollAt: now.toISOString(),
    nextPollAt: new Date(now.getTime() + interval * 1000).toISOString(),
    failures: 0,
    lastError: '',
    lastResult: 'ok',
    tokenSource: source,
    ...outcome,
  });
  return { polled: true, reason: 'ok', ...outcome };
}

export async function statusOf(host) {
  const config = normalizeConfig((await host.call('storage', 'settings.get', {})) ?? {});
  const state = await kvGet(host, KEYS.state, {});
  const quota = currentQuota(await kvGet(host, KEYS.quota, null));
  const active = await kvGet(host, KEYS.active, []);
  const limit = config.maxRunsPerDay > 0 ? `/${config.maxRunsPerDay}` : '';
  const text = config.enabled ? `接活 ${quota.runs}${limit}` : '接活已关';
  const tooltip = [
    `主动接活：${config.enabled ? '开' : '关'}`,
    `今日已接 ${quota.runs}${limit} 次，进行中 ${Array.isArray(active) ? active.length : 0}`,
    config.maxTokensPerDay > 0 ? `今日 token ${quota.tokens}/${config.maxTokensPerDay}` : `今日 token ${quota.tokens}`,
    quota.tokensUnknownRuns ? `${quota.tokensUnknownRuns} 次未上报用量` : '',
    state.lastPollAt ? `上次检查 ${state.lastPollAt}` : '尚未检查',
    state.lastError ? `最近错误：${state.lastError}` : '',
    config.allowedSenders.length === 0 ? '白名单为空，不会接任何活' : '',
  ].filter(Boolean).join('\n');
  return { text, tooltip, config, state, quota, active };
}

export default definePluginWorker((plugin, environment) => {
  plugin.handle('intake.tick', async (_input, env) => {
    try {
      return await runTick(env.host);
    } catch (error) {
      env.log.error('intake tick failed', { error: String(error?.message ?? error) });
      return { polled: false, reason: 'error' };
    }
  });
  plugin.handle('intake.pollNow', async (_input, env) => {
    const result = await runTick(env.host, { force: true });
    await toast(env.host, '主动接活', result.polled
      ? `已检查：接 ${result.admitted ?? 0}，拒 ${result.refused ?? 0}`
      : `没有检查：${result.reason}`);
    return result;
  });
  plugin.handle('intake.status', async (_input, env) => {
    const { text, tooltip } = await statusOf(env.host);
    return { text, tooltip };
  });
  plugin.handle('intake.forgetToken', async (_input, env) => {
    await env.host.call('secrets', 'delete', { key: TOKEN_SECRET });
    await toast(env.host, '主动接活', '已删除保存的 GitHub token，之后会改用 gh 登录的账号。');
    return { ok: true };
  });
  void environment;
});
