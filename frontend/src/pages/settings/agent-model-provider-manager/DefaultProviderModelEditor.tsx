import { useTranslation } from 'react-i18next';
import type { AgentId } from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';

import { HARK_PROTOCOLS } from './constants';
import { ProviderModelField } from './ProviderModelField';
import {
  enabledModelIds,
  parsePiModel,
  selectedModelIds,
  serializeSelectedModels,
} from './providerModelParse';

export function DefaultProviderModelEditor({
  agentId,
  value,
  choices,
  disabled,
  onChange,
}: {
  agentId: AgentId;
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const ids = selectedModelIds(value);
  const harkModel =
    agentId === 'hark' ? parsePiModel(value, 'openai-completions') : null;
  const patch = (id: string) => {
    const enabled = enabledModelIds(value);
    if (harkModel) {
      const payload: Record<string, unknown> = {
        ...harkModel.raw,
        id,
        api: harkModel.api,
      };
      if (Array.isArray(harkModel.raw.models)) {
        payload.models = parsePiModel(
          serializeSelectedModels('hark', value, enabled)
        ).raw.models;
      }
      onChange(JSON.stringify(payload));
      return;
    }
    if (id !== '' && enabled.includes(id)) {
      onChange(
        serializeSelectedModels(agentId, value, [
          id,
          ...enabled.filter((item) => item !== id),
        ])
      );
      return;
    }
    if (enabled.length === 0) {
      onChange(id);
      return;
    }
    // A typed id becomes the default; the enabled list stays the detection
    // panel's, matching Pi so keystrokes do not fill that list with fragments.
    onChange(
      JSON.stringify({
        default: id,
        id,
        models: enabled,
      })
    );
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.model')}</legend>
      <ProviderModelField
        ariaLabel={t('agents.providerModelAria')}
        choices={choices}
        disabled={disabled}
        label={t('agents.model')}
        name={`${agentId}_model_provider_model`}
        value={harkModel ? harkModel.id : (ids[0] ?? '')}
        onChange={patch}
        onSelectChoice={
          harkModel
            ? (id) =>
                onChange(
                  serializeSelectedModels('hark', value, [
                    id,
                    ...enabledModelIds(value).filter((item) => item !== id),
                  ])
                )
            : undefined
        }
      />
      {harkModel ? (
        <label>
          {t('agents.customProviderProtocol')}
          <AstryxSelect
            ariaLabel={t('agents.customProviderProtocol')}
            disabled={disabled}
            value={harkModel.api}
            options={HARK_PROTOCOLS.map((protocol) => ({
              value: protocol,
              label: protocol,
            }))}
            onChange={(api) =>
              onChange(
                JSON.stringify({
                  ...harkModel.raw,
                  id: harkModel.id,
                  api,
                })
              )
            }
          />
        </label>
      ) : null}
      {harkModel ? (
        <p className="text-xs text-muted-foreground">
          {t('agents.harkProviderUrlHint')}
        </p>
      ) : null}
    </fieldset>
  );
}
