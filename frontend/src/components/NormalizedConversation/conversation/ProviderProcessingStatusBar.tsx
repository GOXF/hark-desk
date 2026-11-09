import { Activity, CirclePause, CircleStop } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  stripStatusBrand,
  type ProviderProcessingState,
} from '@/features/conversation/providerProcessingStatus';

export function ProviderProcessingStatusBar({
  state,
}: {
  state: ProviderProcessingState | null;
}) {
  const { t } = useTranslation('conversation');
  if (!state) return null;
  const { stage } = state;
  const interrupted = stage.reason === 'error' || stage.reason === 'cancelled';
  const label = interrupted
    ? t('processingStatus.interrupted')
    : t(`processingStatus.${stage.status}`);
  const Icon =
    stage.status === 'processing'
      ? Activity
      : stage.status === 'waiting_for_user'
        ? CirclePause
        : CircleStop;
  const line =
    stage.status === 'ended' ? '' : stripStatusBrand(stage.line ?? '');
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={t('processingStatus.title')}
      className="flex shrink-0 items-start gap-2 px-3 py-2 text-xs text-muted-foreground"
      data-state={stage.status}
    >
      <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <p className="min-w-0 break-words">
        {label}
        {line ? ` · ${line}` : ''}
      </p>
    </section>
  );
}
