import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@/features/agents/types';
import {
  reduceProviderProcessingStatus,
  stripStatusBrand,
} from './providerProcessingStatus';

const envelope = (
  sequence: number,
  status: string,
  request = 'r1',
  ordinal = 1
): AgentEventEnvelope => ({
  sequence,
  workspace_id: 'w',
  connection_id: 'connection',
  session_id: 'conversation',
  created_at: '2026-11-09T00:00:00Z',
  event: {
    kind: 'session_info_updated',
    patch: {
      _meta: {
        hark: {
          requestOrdinal: ordinal,
          status: {
            type: 'hark.status',
            status,
            request_id: request,
            conversation_id: 'project',
            message_id: 'assistant',
            sequence: Number(sequence),
            line: 'Hark 正在处理文件',
          },
        },
      },
    },
  },
});
describe('independent provider status', () => {
  it('takes status only from scoped structured metadata and leaves event content untouched', () => {
    const event = envelope(1, 'processing');
    const before = JSON.stringify(event, (_, v) =>
      typeof v === 'bigint' ? String(v) : v
    );
    expect(reduceProviderProcessingStatus(null, event, 'other')).toBeNull();
    expect(
      reduceProviderProcessingStatus(null, event, 'conversation')?.stage.line
    ).toBe('Hark 正在处理文件');
    expect(
      JSON.stringify(event, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    ).toBe(before);
  });
  it('waiting does not regress, and stale request ordinals and sequences are ignored', () => {
    const waiting = reduceProviderProcessingStatus(
      null,
      envelope(2, 'waiting_for_user'),
      'conversation'
    );
    expect(
      reduceProviderProcessingStatus(
        waiting,
        envelope(3, 'processing'),
        'conversation'
      )
    ).toBe(waiting);
    expect(
      reduceProviderProcessingStatus(
        waiting,
        envelope(4, 'ended'),
        'conversation'
      )
    ).toBe(waiting);
    const newer = reduceProviderProcessingStatus(
      waiting,
      envelope(5, 'processing', 'r2', 2),
      'conversation'
    );
    expect(newer?.stage.request_id).toBe('r2');
    expect(
      reduceProviderProcessingStatus(
        newer,
        envelope(6, 'processing', 'r1', 1),
        'conversation'
      )
    ).toBe(newer);
    expect(
      reduceProviderProcessingStatus(
        newer,
        envelope(4, 'processing', 'r2', 2),
        'conversation'
      )
    ).toBe(newer);
  });
  it('ordinary messages never become stages and terminal events only settle a real stage', () => {
    const base = envelope(1, 'processing');
    const message: AgentEventEnvelope = {
      ...base,
      event: {
        kind: 'message_chunk',
        content: { kind: 'text', text: '正在处理 Hark 文件' },
      },
    };
    expect(
      reduceProviderProcessingStatus(null, message, 'conversation')
    ).toBeNull();
    const active = reduceProviderProcessingStatus(null, base, 'conversation');
    const end: AgentEventEnvelope = {
      ...base,
      sequence: 2,
      event: { kind: 'turn_completed' },
    };
    expect(
      reduceProviderProcessingStatus(active, end, 'conversation')?.stage.status
    ).toBe('ended');
    expect(
      reduceProviderProcessingStatus(null, end, 'conversation')
    ).toBeNull();
  });
  it('strips provider branding only for display with English and Chinese boundaries', () => {
    expect(stripStatusBrand('HARK Desk：正在处理文件')).toBe('正在处理文件');
    expect(stripStatusBrand('Hark正在处理文件')).toBe('正在处理文件');
    expect(stripStatusBrand('Hark2API：正在处理文件')).toBe('正在处理文件');
    expect(stripStatusBrand('HarkPro 正在处理文件')).toBe('正在处理文件');
    expect(stripStatusBrand('HarkDesk 正在处理文件')).toBe('正在处理文件');
    expect(stripStatusBrand('Hark Pro 正在处理文件')).toBe('正在处理文件');
    expect(stripStatusBrand('shark Harkness harking')).toBe(
      'shark Harkness harking'
    );
  });
  it('settles actual cancellation and connection loss without affecting another connection', () => {
    const initial = envelope(1, 'processing');
    const active = reduceProviderProcessingStatus(
      null,
      initial,
      'conversation'
    );
    const cancelled: AgentEventEnvelope = {
      ...initial,
      sequence: 2,
      event: {
        kind: 'prompt_finished',
        finished: { prompt_id: 'prompt', stop_reason: 'cancelled' },
      },
    };
    expect(
      reduceProviderProcessingStatus(active, cancelled, 'conversation')?.stage
        .reason
    ).toBe('cancelled');
    const waiting = reduceProviderProcessingStatus(
      null,
      envelope(1, 'waiting_for_user'),
      'conversation'
    );
    expect(
      reduceProviderProcessingStatus(waiting, cancelled, 'conversation')?.stage
        .reason
    ).toBe('cancelled');
    const lost: AgentEventEnvelope = {
      ...initial,
      sequence: 3,
      session_id: null,
      event: {
        kind: 'connection_status_changed',
        snapshot: {
          id: 'connection',
          agent_type: 'hark',
          workspace_id: 'w',
          status: 'disconnected',
          working_dir: '',
          created_at: 'now',
          updated_at: 'now',
        },
      },
    };
    expect(
      reduceProviderProcessingStatus(
        active,
        { ...lost, connection_id: 'other' },
        'conversation'
      )
    ).toBe(active);
    expect(
      reduceProviderProcessingStatus(active, lost, 'conversation')?.stage.reason
    ).toBe('error');
  });
});
