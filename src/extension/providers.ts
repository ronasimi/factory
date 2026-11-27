import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

export const FACTORY_PROVIDER_ID = 'factory-llama';
export const DEFAULT_LLAMA_BASE_URL = 'http://192.168.1.101:8080/v1';

export const SLOT_LIMITS = {
  orchestrator: 1,
  subagents: 3,
} as const;

export interface LlamaEndpointConfig {
  baseUrl: string;
  apiKey: string;
  orchestratorModelId: string;
  subagentModelId: string;
}

/**
 * Resolve llama-server API key from environment or the user's ~/.pi/agent/models.json
 * (`providers.desktop.apiKey`) so credentials are never hardcoded in source.
 */
export function resolveLlamaApiKey(homeDir = homedir()): string {
  const fromEnv = process.env.FACTORY_LLAMA_API_KEY ?? process.env.LLAMA_SERVER_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  const modelsJsonPath = join(homeDir, '.pi', 'agent', 'models.json');
  if (existsSync(modelsJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsJsonPath, 'utf8')) as {
        providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
      };
      const desktopKey = parsed.providers?.desktop?.apiKey;
      if (desktopKey && desktopKey.trim().length > 0) return desktopKey.trim();
    } catch {
      // Ignore malformed models.json and fall through to placeholder.
    }
  }

  return 'llama-cpp';
}

export function getLlamaEndpointConfig(): LlamaEndpointConfig {
  return {
    baseUrl: process.env.FACTORY_LLAMA_URL ?? DEFAULT_LLAMA_BASE_URL,
    apiKey: resolveLlamaApiKey(),
    orchestratorModelId: process.env.FACTORY_ORCHESTRATOR_MODEL ?? 'lfm-aa1',
    subagentModelId: process.env.FACTORY_SUBAGENT_MODEL ?? 'lfm-aa1',
  };
}

export function buildFactoryProviderConfig(config: LlamaEndpointConfig): ProviderConfig {
  const compat = {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsMidConvoSystemMessages: false,
  };

  const models: NonNullable<ProviderConfig['models']> = [
    {
      id: config.subagentModelId,
      name:
        config.orchestratorModelId === config.subagentModelId
          ? 'Singleton + Instance (LFM3-AA1)'
          : 'Instance (LFM3-AA1 Subagent & Utility)',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 16384,
      compat,
    },
  ];

  if (config.orchestratorModelId !== config.subagentModelId) {
    models.unshift({
      id: config.orchestratorModelId,
      name: 'Singleton (LFM3-AA1o Multimodal Orchestrator)',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 4096,
      compat,
    });
  }

  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: 'openai-completions',
    models,
  };
}

export function registerFactoryProvider(pi: ExtensionAPI): LlamaEndpointConfig {
  const endpoint = getLlamaEndpointConfig();
  pi.registerProvider(FACTORY_PROVIDER_ID, buildFactoryProviderConfig(endpoint));
  return endpoint;
}
