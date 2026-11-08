import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentKind, ExecutorProfileId, TimelineRow } from 'shared/types';
import { resolveResendExecutorProfile } from '@/contexts/ActiveExecutorProfileContext';
import { useFollowUpSend } from '@/hooks/useFollowUpSend';
import {
  getConversationSessionFacts,
  getConversationTimelineView,
  type ConversationTimelineView,
} from './conversationTimelineRegistry';

const EMPTY_IMAGES: string[] = [];
const NOOP = () => {};

export function currentTurnErrorRow(
  view: ConversationTimelineView
): TimelineRow | undefined {
  const user = view.timeline.findLast(
    (row) => row.turn.role === 'user' && !row.turn.id.includes(':steer:')
  );
  if (!user) return undefined;
  return view.sideRows.findLast((row) => {
    if (row.row.kind !== 'turn_error') return false;
    const userAlias = row.row_id
      .split('|')
      .find((part) => part.startsWith('user='))
      ?.slice('user='.length);
    if (userAlias) return userAlias === user.turn.id;
    const turnId = row.row.error.turn_id;
    return Boolean(
      turnId && (user.turn.id === `${turnId}:user` || user.turn.id === turnId)
    );
  });
}

function recoveryTarget(
  view: ConversationTimelineView,
  failureRowId: string | null
): string | null {
  if (!failureRowId || currentTurnErrorRow(view)?.row_id !== failureRowId) {
    return null;
  }
  return (
    view.timeline.findLast(
      (row) => row.turn.role === 'user' && !row.turn.id.includes(':steer:')
    )?.key ?? null
  );
}

export function useConversationTurnRecovery({
  conversationId,
  workspaceId,
  executor,
  failureRowId,
  getActiveExecutorProfile,
}: {
  conversationId: string | null;
  workspaceId: string;
  executor: AgentKind | null;
  failureRowId: string | null;
  getActiveExecutorProfile: () => ExecutorProfileId | null;
}): { onContinue: (() => Promise<void>) | undefined; error: string | null } {
  const { t } = useTranslation(['conversation']);
  const acceptedFailure = useRef<string | null>(null);
  const expectedRecovery = useRef<{
    conversationId: string;
    failureRowId: string;
    acpSessionId: string;
    target: string;
  } | null>(null);
  const failureKey = `${conversationId}:${failureRowId}`;
  const getProfile = useCallback(
    () =>
      executor
        ? resolveResendExecutorProfile(getActiveExecutorProfile(), executor)
        : null,
    [executor, getActiveExecutorProfile]
  );
  const beforeSubmit = useCallback(async () => {
    expectedRecovery.current = null;
    const facts = getConversationSessionFacts(conversationId);
    const view = getConversationTimelineView(conversationId);
    const target = recoveryTarget(view, failureRowId);
    if (
      !conversationId ||
      !failureRowId ||
      executor !== 'hark' ||
      !facts.acpSessionId ||
      facts.turnInFlight ||
      facts.loading ||
      !target ||
      acceptedFailure.current === failureKey
    ) {
      throw new Error(t('turnErrorCard.continueUnavailable'));
    }

    await view.reconnectAndReload();
    const recovered = getConversationSessionFacts(conversationId);
    const reloaded = getConversationTimelineView(conversationId);
    if (
      recovered.error ||
      recovered.loading ||
      recovered.turnInFlight ||
      recovered.acpSessionId !== facts.acpSessionId ||
      !reloaded.sessionBindReady ||
      recoveryTarget(reloaded, failureRowId) !== target
    ) {
      throw new Error(
        recovered.error ?? t('turnErrorCard.continueUnavailable')
      );
    }
    expectedRecovery.current = {
      conversationId,
      failureRowId,
      acpSessionId: facts.acpSessionId,
      target,
    };
  }, [conversationId, executor, failureKey, failureRowId, t]);
  const validateSubmission = useCallback(
    (optimisticTurnId: string) => {
      const expected = expectedRecovery.current;
      if (!expected) throw new Error(t('turnErrorCard.continueUnavailable'));
      const facts = getConversationSessionFacts(expected.conversationId, {
        ignoreOptimisticTurnId: optimisticTurnId,
      });
      const view = getConversationTimelineView(expected.conversationId);
      const target = recoveryTarget(
        {
          ...view,
          timeline: view.timeline.filter(
            (row) =>
              row.turn.id !== optimisticTurnId &&
              row.turn.id !== `${optimisticTurnId}:assistant`
          ),
        },
        expected.failureRowId
      );
      if (
        facts.error ||
        facts.loading ||
        facts.turnInFlight ||
        facts.acpSessionId !== expected.acpSessionId ||
        !view.sessionBindReady ||
        target !== expected.target
      ) {
        throw new Error(facts.error ?? t('turnErrorCard.continueUnavailable'));
      }
    },
    [t]
  );
  const markAccepted = useCallback(() => {
    acceptedFailure.current = failureKey;
  }, [failureKey]);
  const send = useFollowUpSend({
    sessionId: conversationId ?? undefined,
    sessionExecutor: executor,
    workspaceId,
    message: t('turnErrorCard.continuePrompt'),
    images: EMPTY_IMAGES,
    executorProfileId: getProfile,
    conflictMarkdown: null,
    reviewMarkdown: '',
    clearComments: NOOP,
    beforeSubmit,
    validateSubmission,
    onAfterSendCleanup: markAccepted,
  });
  const canContinue = Boolean(
    conversationId &&
      executor === 'hark' &&
      acceptedFailure.current !== failureKey &&
      recoveryTarget(getConversationTimelineView(conversationId), failureRowId)
  );
  return {
    onContinue: canContinue ? send.onSendFollowUp : undefined,
    error: send.followUpError,
  };
}
