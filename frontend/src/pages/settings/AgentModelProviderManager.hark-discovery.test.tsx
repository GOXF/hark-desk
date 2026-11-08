import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModelProviderView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { AgentModelProviderManager } from './AgentModelProviderManager';
import { pickAstryxOption } from './agentSettingsTestUtils';

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/features/agent-management', () => ({
  agentManagementErrorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
  agentManagementApi: {
    modelProviders: vi.fn(),
    saveModelProvider: vi.fn(),
    bindModelProvider: vi.fn(),
    deleteModelProvider: vi.fn(),
    probeModelProvider: vi.fn(),
    previewModelProviderImport: vi.fn(),
    importModelProviders: vi.fn(),
    codexModelCatalog: vi.fn(),
    codexModelCatalogConfig: vi.fn(),
    modelProviderCatalog: vi.fn(),
  },
}));

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => ({
    contributionCatalog: async () => ({ generation: 0, items: [] }),
    providerCatalogList: async () => ({
      agent_id: 'hark',
      generation: 0,
      templates: [],
      sources: [],
    }),
    invokeContribution: async () => ({}),
  }),
}));

const aliases = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];

function configureProvider(model: string): AgentModelProviderView {
  const provider: AgentModelProviderView = {
    id: 'provider-hark',
    name: 'Hark gateway',
    agent_id: 'hark',
    api_url: 'https://gateway.example/v1',
    api_key: '',
    model: JSON.stringify({
      id: model,
      api: 'anthropic-messages',
      models: [model],
    }),
    credential_present: true,
    bound: true,
    managed: true,
  };
  const view = {
    agent_id: 'hark',
    providers: [provider],
    bound_provider_id: provider.id,
  };
  vi.mocked(agentManagementApi.modelProviders).mockResolvedValue(view);
  vi.mocked(agentManagementApi.saveModelProvider).mockResolvedValue(view);
  return provider;
}

describe('Hark provider discovery and explicit model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentManagementApi.modelProviderCatalog).mockResolvedValue({
      agent_id: 'hark',
      source: 'live',
      models: aliases.map((model) => ({
        ...model,
        context_window: null,
        reasoning_levels: [],
      })),
      default_model: null,
      error: null,
    });
  });

  it.each(['*', 'claude-*'])(
    'keeps refresh read-only and removes old pattern %s only after explicit aliases and save',
    async (pattern) => {
      const provider = configureProvider(pattern);
      const user = userEvent.setup();
      render(
        <AgentModelProviderManager agentId="hark" disabled={false} embedded />
      );
      await user.click(
        await screen.findByRole('button', { name: '编辑 Hark gateway' })
      );
      expect(
        await screen.findByRole('checkbox', { name: /Claude Sonnet 4.6/ })
      ).not.toBeChecked();
      expect(agentManagementApi.modelProviderCatalog).toHaveBeenCalledWith(
        'hark',
        provider.id,
        provider.api_url,
        null
      );
      await user.click(screen.getByRole('button', { name: '检测模型' }));
      await waitFor(() => {
        expect(agentManagementApi.modelProviderCatalog).toHaveBeenCalledTimes(
          2
        );
      });
      expect(screen.getByLabelText('Provider 模型')).toHaveTextContent(pattern);
      expect(agentManagementApi.saveModelProvider).not.toHaveBeenCalled();
      expect(agentManagementApi.bindModelProvider).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole('checkbox', { name: /Claude Opus 4.6/ })
      );
      await user.click(
        screen.getByRole('checkbox', { name: /Claude Sonnet 4.6/ })
      );
      await pickAstryxOption(
        user,
        screen.getByLabelText('Provider 模型'),
        'claude-sonnet-4-6'
      );
      expect(agentManagementApi.saveModelProvider).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '保存修改' }));

      expect(agentManagementApi.saveModelProvider).toHaveBeenCalledTimes(1);
      const request = vi.mocked(agentManagementApi.saveModelProvider).mock
        .calls[0][0];
      expect(request.agent_id).toBe('hark');
      expect(request.id).toBe(provider.id);
      expect(request.api_key).toBeNull();
      expect(JSON.parse(request.model)).toEqual({
        id: 'claude-sonnet-4-6',
        api: 'anthropic-messages',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      });
      expect(agentManagementApi.bindModelProvider).not.toHaveBeenCalled();
    }
  );

  it.each(['*', 'claude-*'])(
    'cleans old pattern %s when a concrete primary is selected directly without checkbox toggles',
    async (pattern) => {
      const provider = configureProvider(pattern);
      const user = userEvent.setup();
      render(
        <AgentModelProviderManager agentId="hark" disabled={false} embedded />
      );
      await user.click(
        await screen.findByRole('button', { name: '编辑 Hark gateway' })
      );
      expect(
        await screen.findByRole('checkbox', { name: /Claude Sonnet 4.6/ })
      ).not.toBeChecked();
      expect(screen.getByLabelText('Provider 模型')).toHaveTextContent(pattern);
      expect(agentManagementApi.saveModelProvider).not.toHaveBeenCalled();
      expect(agentManagementApi.bindModelProvider).not.toHaveBeenCalled();

      await pickAstryxOption(
        user,
        screen.getByLabelText('Provider 模型'),
        'claude-sonnet-4-6'
      );
      expect(agentManagementApi.saveModelProvider).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '保存修改' }));

      expect(agentManagementApi.saveModelProvider).toHaveBeenCalledTimes(1);
      const request = vi.mocked(agentManagementApi.saveModelProvider).mock
        .calls[0][0];
      expect(request.agent_id).toBe('hark');
      expect(request.id).toBe(provider.id);
      expect(request.api_key).toBeNull();
      expect(JSON.parse(request.model)).toEqual({
        id: 'claude-sonnet-4-6',
        api: 'anthropic-messages',
        models: ['claude-sonnet-4-6'],
      });
      expect(agentManagementApi.bindModelProvider).not.toHaveBeenCalled();
    }
  );

  it.each(['private-model', 'claude-sonnet-4-6-private'])(
    'cleans hidden patterns during handwritten primary edit %s without enabling typed prefixes',
    async (modelId) => {
      configureProvider('*');
      const user = userEvent.setup();
      render(
        <AgentModelProviderManager agentId="hark" disabled={false} embedded />
      );
      await user.click(
        await screen.findByRole('button', { name: '编辑 Hark gateway' })
      );
      await screen.findByRole('checkbox', { name: /Claude Sonnet 4.6/ });
      await pickAstryxOption(
        user,
        screen.getByLabelText('Provider 模型'),
        '自定义模型 ID…'
      );
      const input = screen.getByLabelText('Provider 模型');
      await user.clear(input);
      await user.type(input, modelId);
      expect(agentManagementApi.saveModelProvider).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '保存修改' }));

      const request = vi.mocked(agentManagementApi.saveModelProvider).mock
        .calls[0][0];
      expect(JSON.parse(request.model)).toEqual({
        id: modelId,
        api: 'anthropic-messages',
        models: [],
      });
      expect(agentManagementApi.bindModelProvider).not.toHaveBeenCalled();
    }
  );

  it('preserves a valid selected concrete default when refreshed models have another first entry', async () => {
    configureProvider('claude-sonnet-4-6');
    const user = userEvent.setup();
    render(
      <AgentModelProviderManager agentId="hark" disabled={false} embedded />
    );
    await user.click(
      await screen.findByRole('button', { name: '编辑 Hark gateway' })
    );
    expect(
      await screen.findByRole('checkbox', { name: /Claude Sonnet 4.6/ })
    ).toBeChecked();
    expect(screen.getByLabelText('Provider 模型')).toHaveTextContent(
      'claude-sonnet-4-6'
    );
    expect(agentManagementApi.saveModelProvider).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /Claude Opus 4.6/ }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const request = vi.mocked(agentManagementApi.saveModelProvider).mock
      .calls[0][0];
    expect(JSON.parse(request.model)).toEqual({
      id: 'claude-sonnet-4-6',
      api: 'anthropic-messages',
      models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    });
  });
});
