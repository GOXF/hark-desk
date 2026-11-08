import { describe, expect, it } from 'vitest';

import { serializeSelectedModels } from './providerModelParse';

describe('Hark provider model selection', () => {
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'])(
    'preserves %s when detected models are selected',
    (api) => {
      const current = JSON.stringify({
        id: 'model-a',
        api,
        models: ['model-a'],
      });
      expect(
        JSON.parse(
          serializeSelectedModels('hark', current, ['model-b', 'model-a'])
        )
      ).toEqual({ id: 'model-b', api, models: ['model-b', 'model-a'] });
    }
  );

  it('uses Chat Completions for a Hark model without an explicit protocol', () => {
    expect(
      JSON.parse(serializeSelectedModels('hark', '', ['private-model']))
    ).toEqual({
      id: 'private-model',
      api: 'openai-completions',
      models: ['private-model'],
    });
  });

  it('retains the existing Pi Responses default', () => {
    expect(
      JSON.parse(serializeSelectedModels('pi', '', ['private-model']))
    ).toEqual({
      id: 'private-model',
      api: 'openai-responses',
      models: ['private-model'],
    });
  });
});
