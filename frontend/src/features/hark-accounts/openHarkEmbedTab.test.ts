import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';

import { getHarkOpenMode, setHarkOpenMode } from './harkWindowApi';
import {
  HARK_EMBED_PANEL_COMPONENT,
  harkEmbedPanelId,
  openOrFocusHarkEmbedPanel,
  requestHarkEmbedOpen,
  setHarkEmbedOpenHandler,
} from './openHarkEmbedTab';

afterEach(() => {
  setHarkEmbedOpenHandler(null);
  localStorage.clear();
});

describe('hark open mode', () => {
  it('defaults to the embedded tab and remembers the choice', () => {
    expect(getHarkOpenMode()).toBe('tab');
    setHarkOpenMode('window');
    expect(localStorage.getItem('hark.openMode')).toBe('window');
    expect(getHarkOpenMode()).toBe('window');
    setHarkOpenMode('tab');
    expect(getHarkOpenMode()).toBe('tab');
  });
});

describe('requestHarkEmbedOpen', () => {
  it('queues until a handler registers, keeping one request per account', () => {
    expect(requestHarkEmbedOpen({ accountId: 'a', accountName: '一' })).toBe(
      false
    );
    requestHarkEmbedOpen({ accountId: 'a', accountName: '一改' });
    requestHarkEmbedOpen({ accountId: 'b', accountName: '二' });
    const handler = vi.fn();
    setHarkEmbedOpenHandler(handler, () => null);
    expect(handler.mock.calls.map(([r]) => r)).toEqual([
      { accountId: 'a', accountName: '一改' },
      { accountId: 'b', accountName: '二' },
    ]);
    expect(requestHarkEmbedOpen({ accountId: 'c', accountName: '三' })).toBe(
      true
    );
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe('openOrFocusHarkEmbedPanel', () => {
  it('focuses the existing tab for the same account', () => {
    const setActive = vi.fn();
    const setTitle = vi.fn();
    const existing = {
      id: harkEmbedPanelId('a'),
      params: { accountId: 'a' },
      api: { setActive, setTitle, updateParameters: vi.fn() },
      group: { api: { setVisible: vi.fn() } },
    };
    const api = {
      getPanel: (id: string) => (id === existing.id ? existing : undefined),
      panels: [existing],
      addPanel: vi.fn(),
    } as unknown as DockviewApi;
    const addPanel = vi.fn();
    openOrFocusHarkEmbedPanel(
      api,
      { accountId: 'a', accountName: '一' },
      addPanel
    );
    expect(addPanel).not.toHaveBeenCalled();
    expect(setTitle).toHaveBeenCalledWith('Hark · 一');
    expect(setActive).toHaveBeenCalled();
  });

  it('adds a new hark-embed panel otherwise', () => {
    const setActive = vi.fn();
    const api = {
      getPanel: () => undefined,
      panels: [],
      addPanel: vi.fn(),
    } as unknown as DockviewApi;
    const addPanel = vi.fn(() => ({ api: { setActive } }));
    openOrFocusHarkEmbedPanel(
      api,
      { accountId: 'b', accountName: '二' },
      addPanel
    );
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: harkEmbedPanelId('b'),
        component: HARK_EMBED_PANEL_COMPONENT,
        title: 'Hark · 二',
        params: { accountId: 'b', accountName: '二' },
      })
    );
    expect(setActive).toHaveBeenCalled();
  });
});
