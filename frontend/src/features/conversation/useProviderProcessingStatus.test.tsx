import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '@/features/agents/types';
import { listenToAgentEvents } from '@/features/agents/events';
import { ProviderProcessingStatusBar } from '@/components/NormalizedConversation/conversation/ProviderProcessingStatusBar';
import { useProviderProcessingStatus } from './useProviderProcessingStatus';
import { reduceProviderProcessingStatus } from './providerProcessingStatus';

vi.mock('@/features/agents/events', () => ({ listenToAgentEvents: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'processingStatus.title': '处理状态',
        'processingStatus.processing': '处理中',
        'processingStatus.waiting_for_user': '等待补充',
        'processingStatus.ended': '已结束',
        'processingStatus.interrupted': '已中断',
      })[key] ?? key,
  }),
}));

const event = (status: string, sequence = 1): AgentEventEnvelope => ({
  sequence,
  workspace_id: 'w',
  connection_id: 'c',
  session_id: 'a',
  created_at: 'now',
  event: {
    kind: 'session_info_updated',
    patch: {
      _meta: {
        hark: {
          requestOrdinal: 1,
          status: {
            type: 'hark.status',
            status,
            request_id: 'r',
            conversation_id: 'p',
            sequence,
            line: 'Hark 正在处理文件',
          },
        },
      },
    },
  },
});

describe('provider processing status subscription and presentation', () => {
  let callbacks: ((e: AgentEventEnvelope) => void)[];
  const stop = vi.fn();
  beforeEach(() => {
    callbacks = [];
    stop.mockReset();
    vi.mocked(listenToAgentEvents).mockImplementation((callback) => {
      callbacks.push(callback);
      return Promise.resolve(stop);
    });
  });
  it('does not subscribe for another agent and has no made-up loading stage', () => {
    const { result } = renderHook(() =>
      useProviderProcessingStatus('a', false)
    );
    expect(result.current).toBeNull();
    expect(callbacks).toHaveLength(0);
  });
  it('isolates conversations and ignores callbacks after cleanup', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ id }) => useProviderProcessingStatus(id, true),
      { initialProps: { id: 'a' } }
    );
    act(() => callbacks[0](event('processing')));
    expect(result.current?.stage.status).toBe('processing');
    rerender({ id: 'b' });
    expect(result.current).toBeNull();
    act(() => callbacks[0](event('waiting_for_user', 2)));
    expect(result.current).toBeNull();
    act(() => callbacks[1](event('processing', 3)));
    expect(result.current).toBeNull();
    unmount();
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  });
  it('renders an independent live region without provider branding or a success claim', () => {
    const state = reduceProviderProcessingStatus(
      null,
      event('processing'),
      'a'
    );
    const { rerender } = render(<ProviderProcessingStatusBar state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      '处理中 · 正在处理文件'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/hark/i);
    const ended = state
      ? { ...state, stage: { ...state.stage, status: 'ended' as const } }
      : null;
    rerender(<ProviderProcessingStatusBar state={ended} />);
    expect(screen.getByRole('status')).toHaveTextContent('已结束');
    expect(screen.getByRole('status')).not.toHaveTextContent(
      /完成|成功|正在处理文件/
    );
  });
  it('waiting is visible after normal stream end while real errors interrupt it', () => {
    const waiting = reduceProviderProcessingStatus(
      null,
      event('waiting_for_user'),
      'a'
    );
    const ended = event('ended', 2);
    if (ended.event.kind === 'session_info_updated')
      ended.event.patch = {
        _meta: {
          hark: {
            requestOrdinal: 1,
            status: {
              type: 'hark.status',
              status: 'ended',
              reason: 'error',
              request_id: 'r',
              conversation_id: 'p',
              sequence: 2,
            },
          },
        },
      };
    const interrupted = reduceProviderProcessingStatus(waiting, ended, 'a');
    render(<ProviderProcessingStatusBar state={interrupted} />);
    expect(screen.getByRole('status')).toHaveTextContent('已中断');
  });
});
