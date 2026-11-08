import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { promptContextRegistry } from '@vibex/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpCapabilitySnapshot,
  AgentKind,
  DbConversationDetail,
  ExecutorProfileId,
} from 'shared/types';
import {
  configureBackendTransport,
  tauriBackendTransport,
} from '@/lib/backendTransport';
import { ConversationStatusDock } from '@/components/tasks/follow-up/ConversationStatusDock';
import { useConversationTimeline } from './useConversationTimeline';
import {
  currentTurnErrorRow,
  useConversationTurnRecovery,
} from './useConversationTurnRecovery';
import {
  getConversationTimelineView,
  resetConversationTimelineRegistryForTests,
} from './conversationTimelineRegistry';
import { resetConversationKeepaliveForTests } from './conversationKeepalive';
import { publishOptimisticConversationTurn } from './optimisticTurnEvents';

const capabilities: AcpCapabilitySnapshot = {
  prompt: {
    text: true,
    image: true,
    audio: false,
    resource: false,
    resource_link: false,
  },
  load_session: true,
  resume_session: true,
  close_session: false,
  fork_session: false,
  list_sessions: false,
  delete_session: false,
  steering: false,
  delivery_channel: 'none',
  terminal: true,
  additional_directories: false,
  filesystem_requests: false,
  mcp_stdio: true,
  mcp_http: false,
  mcp_sse: false,
  auth_logout: false,
  auth_status: false,
  modes: [],
  config_options: [],
  available_commands: [],
};
const failure = {
  message: 'turn failed: terminated',
  code: 'internal_error',
  kind: 'service_error' as const,
};

function failedConversation(): DbConversationDetail {
  return {
    summary: {
      id: 'conversation-1',
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'Existing task',
      title_locked: false,
      status: 'inprogress',
      agent_id: 'hark',
      model: null,
      external_session_id: 'existing-acp-session',
      message_count: 2n,
      pinned_at: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-11-08T06:30:00Z',
      updated_at: '2026-11-08T06:31:00Z',
    },
    active_binding: {
      id: 'binding-1',
      agent_type: 'hark',
      working_dir: 'C:/fixture',
      acp_session_id: 'existing-acp-session',
      status: 'ready',
      capabilities,
      delegation_mcp_delivered: false,
    },
    current_turn: { id: 'failed-turn', ordinal: 0n, status: 'failed' },
    turns: [],
    turns_offset: 0,
    turns_total: 2,
    user_turns_before_offset: 0,
    projection_version: 2,
    session_config_options: [],
    timeline: {
      conversation_id: 'conversation-1',
      projection_version: 2,
      last_sequence: 3n,
      truncated_from_start: false,
      older_cursor: null,
      rows: [
        {
          row_id: 'failed-turn:user',
          revision: 1n,
          row: {
            kind: 'message_turn',
            phase: 'failed',
            turn: {
              id: 'failed-turn:user',
              role: 'user',
              timestamp: '2026-11-08T06:30:00Z',
              blocks: [
                { type: 'text', text: 'Finish the existing task' },
                {
                  type: 'image',
                  data: '',
                  mime_type: 'image/png',
                  uri: 'existing.png',
                },
              ],
            },
          },
        },
        {
          row_id: 'failed-turn:assistant',
          revision: 2n,
          row: {
            kind: 'message_turn',
            phase: 'failed',
            turn: {
              id: 'failed-turn:assistant',
              role: 'assistant',
              timestamp: '2026-11-08T06:30:30Z',
              blocks: [
                { type: 'text', text: 'Already completed step one.' },
                {
                  type: 'tool_use',
                  tool_use_id: 'tool-1',
                  tool_name: 'edit',
                  status: 'completed',
                },
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  output_preview: 'file updated',
                  is_error: false,
                },
              ],
            },
          },
        },
        {
          row_id: 'failed-turn:error',
          revision: 3n,
          row: {
            kind: 'turn_error',
            error: { turn_id: 'failed-turn', error: failure },
          },
        },
      ],
    },
  };
}

let saved: DbConversationDetail;
let recover: () => Promise<unknown>;
let load: () => Promise<DbConversationDetail>;
let submit: () => Promise<unknown>;
let profile: ExecutorProfileId;
let executor: AgentKind = 'hark';
let disposePromptContext: (() => void) | undefined;
const call = vi.fn(
  async (
    command: string,
    args?: Record<string, unknown>,
    _options?: { operationId?: string }
  ): Promise<unknown> => {
    switch (command) {
      case 'conversation_detail':
        return load();
      case 'conversation_ensure_session_controls':
        return args?.reload ? recover() : { modes: [], config_options: [] };
      case 'conversation_touch':
        return { ok: true, idleTimeoutSecs: 180 };
      case 'conversation_input_submit':
        return submit();
      case 'conversation_input_list':
        return [];
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  }
);

function RecoverySurface() {
  const conversation = useConversationTimeline('conversation-1');
  const errorRow = currentTurnErrorRow(conversation);
  const recovery = useConversationTurnRecovery({
    conversationId: 'conversation-1',
    workspaceId: 'workspace-1',
    executor,
    failureRowId: errorRow?.row_id ?? null,
    getActiveExecutorProfile: () => profile,
  });
  return (
    <>
      <ConversationStatusDock
        notices={
          errorRow
            ? [
                {
                  id: 'failed-turn:error',
                  kind: 'turn-error',
                  error: failure,
                  onContinue: recovery.onContinue,
                  onReload: conversation.reconnectAndReload,
                },
              ]
            : []
        }
      />
      {recovery.error ? (
        <p data-testid="recovery-error">{recovery.error}</p>
      ) : null}
    </>
  );
}

async function openSurface() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RecoverySurface />
    </QueryClientProvider>
  );
  await waitFor(() =>
    expect(getConversationTimelineView('conversation-1').sessionBindReady).toBe(
      true
    )
  );
  return screen.getByRole('button', { name: '继续任务' });
}

function submissions() {
  return call.mock.calls.filter(
    ([command]) => command === 'conversation_input_submit'
  );
}

describe('failed turn continuation through the real submission pipeline', () => {
  beforeEach(() => {
    resetConversationTimelineRegistryForTests();
    resetConversationKeepaliveForTests();
    saved = failedConversation();
    recover = async () => ({ modes: [], config_options: [] });
    load = async () => saved;
    submit = async () => ({});
    profile = { executor: 'hark', variant: 'selected-profile' };
    executor = 'hark';
    call.mockClear();
    configureBackendTransport({
      environment: 'desktop',
      call,
      listen: async () => () => {},
    });
  });

  afterEach(() => {
    disposePromptContext?.();
    disposePromptContext = undefined;
    resetConversationTimelineRegistryForTests();
    resetConversationKeepaliveForTests();
    configureBackendTransport(tauriBackendTransport);
  });

  it('keeps plain reload passive and preserves messages and completed tool results', async () => {
    await openSurface();
    fireEvent.click(screen.getByRole('button', { name: '重新加载会话' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'conversation_ensure_session_controls',
        { conversationId: 'conversation-1', reload: true }
      )
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '重新加载会话' })
      ).not.toBeDisabled()
    );
    expect(submissions()).toEqual([]);
    expect(
      getConversationTimelineView('conversation-1').timeline.map(
        (row) => row.turn.blocks
      )
    ).toEqual(
      saved.timeline.rows.flatMap((row) =>
        row.row.kind === 'message_turn' ? [row.row.turn.blocks] : []
      )
    );
  });

  it('continues once on the same session without truncating history or replaying the original prompt', async () => {
    const button = await openSurface();
    profile = { executor: 'hark', variant: 'latest-selection' };
    fireEvent.click(button);
    await waitFor(() => expect(submissions()).toHaveLength(1));
    expect(submissions()[0]).toEqual([
      'conversation_input_submit',
      {
        request: {
          conversationId: 'conversation-1',
          payload: expect.objectContaining({
            workspaceId: 'workspace-1',
            agentId: 'hark',
            executorProfileId: {
              executor: 'hark',
              variant: 'latest-selection',
            },
            text: '请从本会话最后保存的进度继续未完成的任务。先检查已有消息、工具结果和当前工作区状态，保留已完成的工作，不重复已成功执行的工具操作，只完成剩余步骤。',
            images: [],
          }),
        },
      },
      { operationId: expect.any(String) },
    ]);
    const history = getConversationTimelineView('conversation-1').timeline;
    expect(history[0].turn.blocks).toEqual(
      saved.timeline.rows[0].row.kind === 'message_turn'
        ? saved.timeline.rows[0].row.turn.blocks
        : []
    );
    expect(history[1].turn.blocks).toEqual(
      saved.timeline.rows[1].row.kind === 'message_turn'
        ? saved.timeline.rows[1].row.turn.blocks
        : []
    );
    expect(saved.active_binding?.acp_session_id).toBe('existing-acp-session');
    expect(
      call.mock.calls.every(
        ([command]) => !/truncate|rebind|create|reset/.test(command)
      )
    ).toBe(true);
  });

  it.each(['connection', 'history', 'identity'] as const)(
    'does not submit after %s recovery failure',
    async (stage) => {
      const button = await openSurface();
      if (stage === 'connection')
        recover = async () => {
          throw new Error('connection still closed');
        };
      if (stage === 'history')
        load = async () => {
          throw new Error('history unavailable');
        };
      if (stage === 'identity')
        saved = {
          ...saved,
          active_binding: {
            ...saved.active_binding!,
            acp_session_id: 'different-session',
          },
        };
      fireEvent.click(button);
      await waitFor(() =>
        expect(screen.getByTestId('recovery-error')).toBeInTheDocument()
      );
      expect(submissions()).toEqual([]);
      expect(
        getConversationTimelineView('conversation-1').timeline
      ).toHaveLength(2);
    }
  );

  it('rejects rapid repeat clicks during recovery and submission', async () => {
    let finishRecovery: () => void = () => {};
    let finishSubmit: () => void = () => {};
    recover = () =>
      new Promise((resolve) => {
        finishRecovery = () => resolve({ modes: [], config_options: [] });
      });
    submit = () =>
      new Promise<void>((resolve) => {
        finishSubmit = resolve;
      });
    const button = await openSurface();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(submissions()).toEqual([]);
    await act(async () => {
      finishRecovery();
    });
    await waitFor(() => expect(submissions()).toHaveLength(1));
    fireEvent.click(button);
    expect(submissions()).toHaveLength(1);
    await act(async () => {
      finishSubmit();
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '继续任务' })).toBeNull()
    );
  });

  it('does not submit if another turn starts while recovery is pending', async () => {
    const button = await openSurface();
    saved = { ...saved, in_flight_user_turn_id: 'another-turn' };
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId('recovery-error')).toBeInTheDocument()
    );
    expect(submissions()).toEqual([]);
  });

  it('leaves recovery actions for other agents unchanged', async () => {
    executor = 'codex';
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <RecoverySurface />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(
        getConversationTimelineView('conversation-1').sessionBindReady
      ).toBe(true)
    );
    expect(screen.queryByRole('button', { name: '继续任务' })).toBeNull();
    expect(
      screen.getByRole('button', { name: '重新加载会话' })
    ).toBeInTheDocument();
    expect(submissions()).toEqual([]);
  });

  it('keeps the recovery action stable when the status context rerenders', async () => {
    const client = new QueryClient();
    const getActiveExecutorProfile = () => profile;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      () => {
        useConversationTimeline('conversation-1');
        return useConversationTurnRecovery({
          conversationId: 'conversation-1',
          workspaceId: 'workspace-1',
          executor: 'hark',
          failureRowId: 'failed-turn:error',
          getActiveExecutorProfile,
        });
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.onContinue).toBeDefined());
    const action = result.current.onContinue;
    rerender();
    expect(result.current.onContinue).toBe(action);
  });

  it('continues a native JSONL failed tail whose message rows are settled', async () => {
    saved = {
      ...saved,
      timeline: {
        ...saved.timeline,
        rows: saved.timeline.rows.map((row, index) =>
          row.row.kind === 'message_turn'
            ? {
                ...row,
                row: {
                  ...row.row,
                  phase: 'settled',
                  turn: {
                    ...row.row.turn,
                    id: index === 0 ? 'acp-1' : 'acp-2',
                  },
                },
              }
            : { ...row, row_id: 'failed-turn:error|user=acp-1|assistant=acp-2' }
        ),
      },
    };
    fireEvent.click(await openSurface());
    await waitFor(() => expect(submissions()).toHaveLength(1));
  });

  it('hides an old failure after a newer completed turn without deleting its history', async () => {
    saved.timeline.rows.push(
      {
        row_id: 'newer-turn:user',
        revision: 4n,
        row: {
          kind: 'message_turn',
          phase: 'settled',
          turn: {
            id: 'newer-turn:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'new question' }],
            timestamp: '2026-11-08T07:00:00Z',
          },
        },
      },
      {
        row_id: 'newer-turn:assistant',
        revision: 5n,
        row: {
          kind: 'message_turn',
          phase: 'settled',
          turn: {
            id: 'newer-turn:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'new answer' }],
            timestamp: '2026-11-08T07:00:01Z',
          },
        },
      }
    );
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <RecoverySurface />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(
        getConversationTimelineView('conversation-1').sessionBindReady
      ).toBe(true)
    );
    expect(screen.queryByText('服务故障')).toBeNull();
    expect(
      getConversationTimelineView('conversation-1').sideRows.some(
        (row) => row.row_id === 'failed-turn:error'
      )
    ).toBe(true);
    expect(getConversationTimelineView('conversation-1').timeline).toHaveLength(
      4
    );
    expect(submissions()).toEqual([]);
  });

  it.each(['inflight', 'completed', 'session', 'optimistic'] as const)(
    'does not submit stale recovery when %s changes during a prompt contributor',
    async (change) => {
      let finishContribution: () => void = () => {};
      const beforeTurn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishContribution = resolve;
          })
      );
      disposePromptContext = promptContextRegistry.register({
        id: 'deferred-recovery-context',
        beforeTurn,
      });
      fireEvent.click(await openSurface());
      await waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce());
      expect(submissions()).toEqual([]);
      if (change === 'optimistic') {
        act(() =>
          publishOptimisticConversationTurn({
            type: 'add',
            conversationId: 'conversation-1',
            turn: {
              id: 'another-optimistic',
              role: 'user',
              blocks: [{ type: 'text', text: 'Another pending task' }],
              timestamp: '2026-11-08T07:00:00Z',
            },
          })
        );
      } else if (change === 'session') {
        saved = {
          ...saved,
          active_binding: {
            ...saved.active_binding!,
            acp_session_id: 'another-acp-session',
          },
        };
      } else {
        saved = {
          ...saved,
          in_flight_user_turn_id: change === 'inflight' ? 'another-turn' : null,
          timeline: {
            ...saved.timeline,
            rows: [
              ...saved.timeline.rows,
              {
                row_id: 'another-turn:user',
                revision: 4n,
                row: {
                  kind: 'message_turn',
                  phase: change === 'inflight' ? 'streaming' : 'settled',
                  turn: {
                    id: 'another-turn:user',
                    role: 'user',
                    blocks: [{ type: 'text', text: 'Another accepted task' }],
                    timestamp: '2026-11-08T07:00:00Z',
                  },
                },
              },
            ],
          },
        };
      }
      if (change !== 'optimistic') {
        act(() => getConversationTimelineView('conversation-1').refresh());
        await waitFor(() =>
          expect(getConversationTimelineView('conversation-1').loading).toBe(
            false
          )
        );
      }
      await act(async () => {
        finishContribution();
      });
      expect(submissions()).toEqual([]);
      await waitFor(() =>
        expect(screen.getByTestId('recovery-error')).toBeInTheDocument()
      );
      expect(
        call.mock.calls.filter(
          ([command, args]) =>
            command === 'conversation_ensure_session_controls' && args?.reload
        )
      ).toHaveLength(1);
    }
  );

  it('accepts unchanged recovery after a deferred contributor while excluding only its own optimistic row', async () => {
    let finishContribution: () => void = () => {};
    const beforeTurn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishContribution = resolve;
        })
    );
    disposePromptContext = promptContextRegistry.register({
      id: 'deferred-recovery-context',
      beforeTurn,
    });
    fireEvent.click(await openSurface());
    await waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce());
    expect(submissions()).toEqual([]);
    await act(async () => {
      finishContribution();
    });
    await waitFor(() => expect(submissions()).toHaveLength(1));
    expect(screen.queryByTestId('recovery-error')).toBeNull();
  });
});
