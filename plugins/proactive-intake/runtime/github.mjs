// GitHub access through the Host's network.fetch. The token never leaves the
// Host broker except as an Authorization header.

import { htmlUrl } from './intake.mjs';

const API = 'https://api.github.com';
export const TOKEN_SECRET = 'github-token';

function headers(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hark-desk-proactive-intake',
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function header(response, name) {
  const all = response?.headers ?? {};
  const key = Object.keys(all).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? all[key] : undefined;
}

async function fetchJson(host, url, token, extra) {
  const response = await host.call('network', 'fetch', {
    url,
    method: 'GET',
    headers: headers(token, extra),
    timeoutMs: 20_000,
  });
  let json = null;
  if (response?.status !== 304 && typeof response?.body === 'string' && response.body) {
    try {
      json = JSON.parse(response.body);
    } catch {
      json = null;
    }
  }
  return { response, json };
}

/**
 * Resolves the GitHub token: the plugin's own secret first, then the token of
 * the user's gh login. Returns { token, source } or { token: '' }.
 */
export async function resolveToken(host) {
  try {
    const stored = await host.call('secrets', 'get', { key: TOKEN_SECRET });
    if (stored?.present && typeof stored.value === 'string' && stored.value.trim()) {
      return { token: stored.value.trim(), source: 'secret' };
    }
  } catch {
    /* fall through to gh */
  }
  try {
    const result = await host.call('exec', 'run', {
      program: 'gh',
      args: ['auth', 'token'],
      timeoutMs: 10_000,
    });
    const token = String(result?.stdout ?? '').trim();
    if (result?.success && token) return { token, source: 'gh' };
  } catch {
    /* gh missing */
  }
  return { token: '', source: 'none' };
}

/**
 * Reads unread notifications. Honors Last-Modified (a 304 costs nothing
 * against the rate limit) and X-Poll-Interval.
 */
export async function listNotifications(host, token, lastModified) {
  const extra = lastModified ? { 'If-Modified-Since': lastModified } : {};
  const { response, json } = await fetchJson(
    host,
    `${API}/notifications?all=false&participating=false&per_page=50`,
    token,
    extra,
  );
  const pollInterval = Number(header(response, 'x-poll-interval')) || 60;
  if (response?.status === 304) {
    return { notifications: [], lastModified, pollInterval, status: 304 };
  }
  if (!response?.ok) {
    const error = new Error(`GitHub /notifications ${response?.status ?? '?'} ${response?.statusText ?? ''}`.trim());
    error.status = response?.status;
    throw error;
  }
  return {
    notifications: Array.isArray(json) ? json : [],
    lastModified: header(response, 'last-modified') ?? lastModified,
    pollInterval,
    status: response.status,
  };
}

/**
 * Turns a notification into an intake event: who triggered it, where, and
 * the text they wrote. The sender is read from the latest comment, or from
 * the issue / PR author when there is no comment.
 */
export async function describeNotification(host, token, n) {
  const subject = n?.subject ?? {};
  const event = {
    id: String(n?.id ?? ''),
    updatedAt: n?.updated_at ?? '',
    reason: n?.reason ?? '',
    repository: n?.repository?.full_name ?? '',
    subjectType: subject.type ?? '',
    title: subject.title ?? '',
    url: htmlUrl(subject.url),
    sender: '',
    body: '',
  };
  const target = subject.latest_comment_url || subject.url;
  if (!target) return event;
  const { response, json } = await fetchJson(host, target, token);
  if (response?.ok && json) {
    event.sender = json.user?.login ?? '';
    event.body = typeof json.body === 'string' ? json.body : '';
    if (json.html_url) event.url = json.html_url;
  }
  return event;
}

/** Marks one notification thread as read (opt-in). */
export async function markRead(host, token, threadId) {
  await host.call('network', 'fetch', {
    url: `${API}/notifications/threads/${encodeURIComponent(threadId)}`,
    method: 'PATCH',
    headers: headers(token),
    timeoutMs: 10_000,
  });
}
