import type { AgentEventEnvelope } from '@/features/agents/types';

export type ProviderProcessingStage = {
  type: 'hark.status';
  status: 'processing' | 'waiting_for_user' | 'ended';
  conversation_id: string;
  request_id: string;
  message_id?: string;
  line?: string;
  line_key?: string;
  sequence: number;
  reason?: 'error' | 'cancelled' | 'stream_ended';
};

export type ProviderProcessingState = {
  stage: ProviderProcessingStage;
  requestOrdinal: number;
  envelopeSequence: number;
  connectionId: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseStage(value: unknown): ProviderProcessingStage | null {
  if (
    !isRecord(value) ||
    value.type !== 'hark.status' ||
    !['processing', 'waiting_for_user', 'ended'].includes(
      String(value.status)
    ) ||
    typeof value.conversation_id !== 'string' ||
    typeof value.request_id !== 'string' ||
    value.request_id.length === 0 ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    (value.line !== undefined && typeof value.line !== 'string') ||
    (typeof value.line === 'string' && value.line.length > 4096) ||
    (value.message_id !== undefined && typeof value.message_id !== 'string') ||
    (value.line_key !== undefined && typeof value.line_key !== 'string') ||
    (value.reason !== undefined &&
      !['error', 'cancelled', 'stream_ended'].includes(String(value.reason)))
  )
    return null;
  const status = value.status;
  if (
    status !== 'processing' &&
    status !== 'waiting_for_user' &&
    status !== 'ended'
  )
    return null;
  const reason = value.reason;
  return {
    type: 'hark.status',
    status,
    conversation_id: value.conversation_id,
    request_id: value.request_id,
    sequence: value.sequence,
    ...(typeof value.message_id === 'string'
      ? { message_id: value.message_id }
      : {}),
    ...(typeof value.line === 'string' ? { line: value.line } : {}),
    ...(typeof value.line_key === 'string' ? { line_key: value.line_key } : {}),
    ...(reason === 'error' ||
    reason === 'cancelled' ||
    reason === 'stream_ended'
      ? { reason }
      : {}),
  };
}

export function reduceProviderProcessingStatus(
  state: ProviderProcessingState | null,
  envelope: AgentEventEnvelope,
  conversationId: string
): ProviderProcessingState | null {
  if (
    (envelope.session_id !== conversationId &&
      !(
        envelope.event.kind === 'connection_status_changed' &&
        state?.connectionId === envelope.connection_id
      )) ||
    (state && envelope.sequence <= state.envelopeSequence)
  )
    return state;
  const event = envelope.event;
  if (event.kind === 'prompt_started') return null;
  const disconnected =
    event.kind === 'connection_status_changed' &&
    (event.snapshot.status === 'failed' ||
      event.snapshot.status === 'disconnected');
  const cancelled =
    event.kind === 'prompt_finished' &&
    event.finished.stop_reason === 'cancelled';
  if (
    event.kind === 'prompt_finished' ||
    event.kind === 'turn_completed' ||
    event.kind === 'error' ||
    disconnected
  ) {
    if (
      !state ||
      state.stage.status === 'ended' ||
      (state.stage.status === 'waiting_for_user' &&
        event.kind !== 'error' &&
        !disconnected &&
        !cancelled)
    )
      return state;
    return {
      ...state,
      envelopeSequence: envelope.sequence,
      stage: {
        ...state.stage,
        status: 'ended',
        line: '',
        line_key: '',
        reason:
          event.kind === 'error' || disconnected
            ? 'error'
            : event.kind === 'prompt_finished' &&
                event.finished.stop_reason === 'cancelled'
              ? 'cancelled'
              : 'stream_ended',
      },
    };
  }
  if (event.kind !== 'session_info_updated' || !isRecord(event.patch))
    return state;
  const meta = event.patch._meta;
  const provider = isRecord(meta) ? meta.hark : undefined;
  if (!isRecord(provider)) return state;
  const stage = parseStage(provider.status);
  const requestOrdinal = provider.requestOrdinal;
  if (
    !stage ||
    typeof requestOrdinal !== 'number' ||
    !Number.isSafeInteger(requestOrdinal) ||
    requestOrdinal < 1
  )
    return state;
  if (state) {
    if (requestOrdinal < state.requestOrdinal) return state;
    if (
      requestOrdinal === state.requestOrdinal &&
      (stage.request_id !== state.stage.request_id ||
        stage.conversation_id !== state.stage.conversation_id ||
        stage.sequence <= state.stage.sequence ||
        state.stage.status === 'ended' ||
        (state.stage.status === 'waiting_for_user' &&
          !(
            stage.status === 'ended' &&
            (stage.reason === 'error' || stage.reason === 'cancelled')
          )))
    )
      return state;
  }
  return {
    stage,
    requestOrdinal,
    envelopeSequence: envelope.sequence,
    connectionId: envelope.connection_id,
  };
}

// Display-only cleanup. The wire value and the assistant transcript stay intact.
export function stripStatusBrand(line: string): string {
  return line
    .replace(/(?<![a-z\d_])hark(?:2api|[ -]*(?:desk|pro))?(?![a-z\d_])/giu, '')
    .replace(/\(\s*\)|（\s*）/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .replace(/^[\s:：·|—-]+|[\s:：·|—-]+$/gu, '');
}
