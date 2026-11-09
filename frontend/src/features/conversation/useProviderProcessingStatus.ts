import { useEffect, useState } from 'react';
import { listenToAgentEvents } from '@/features/agents/events';
import {
  reduceProviderProcessingStatus,
  type ProviderProcessingState,
} from './providerProcessingStatus';

export function useProviderProcessingStatus(
  conversationId: string | null,
  enabled: boolean
): ProviderProcessingState | null {
  const [current, setCurrent] = useState<{
    conversationId: string;
    value: ProviderProcessingState | null;
  } | null>(null);
  useEffect(() => {
    setCurrent(null);
    if (!enabled || !conversationId) return;
    let active = true;
    const unlisten = listenToAgentEvents((envelope) => {
      if (
        !active ||
        (envelope.session_id !== conversationId &&
          envelope.event.kind !== 'connection_status_changed')
      )
        return;
      setCurrent((previous) => {
        const value =
          previous?.conversationId === conversationId ? previous.value : null;
        const next = reduceProviderProcessingStatus(
          value,
          envelope,
          conversationId
        );
        return next === value ? previous : { conversationId, value: next };
      });
    });
    void unlisten.catch(() => undefined);
    return () => {
      active = false;
      void unlisten.then(
        (stop) => stop(),
        () => undefined
      );
    };
  }, [conversationId, enabled]);
  return enabled && current?.conversationId === conversationId
    ? current.value
    : null;
}
