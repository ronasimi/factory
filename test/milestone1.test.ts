import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildFactoryProviderConfig,
  DEFAULT_LLAMA_BASE_URL,
  FACTORY_PROVIDER_ID,
  getLlamaEndpointConfig,
  resolveLlamaApiKey,
  SLOT_LIMITS,
} from '../src/extension/providers.ts';

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.FACTORY_LLAMA_API_KEY;
  delete process.env.LLAMA_SERVER_API_KEY;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('factory provider configuration', () => {
  it('enforces 1 orchestrator slot and up to 3 subagent slots', () => {
    assert.equal(SLOT_LIMITS.orchestrator, 1);
    assert.equal(SLOT_LIMITS.subagents, 3);
  });

  it('defaults to 192.168.1.101:8080 and uses lfm-aa1 placeholder for both roles', () => {
    const cfg = getLlamaEndpointConfig();
    assert.equal(cfg.baseUrl, DEFAULT_LLAMA_BASE_URL);
    assert.equal(cfg.orchestratorModelId, 'lfm-aa1');
    assert.equal(cfg.subagentModelId, 'lfm-aa1');

    const sharedProvider = buildFactoryProviderConfig(cfg);
    assert.equal(FACTORY_PROVIDER_ID, 'factory-llama');
    assert.equal(sharedProvider.api, 'openai-completions');
    assert.equal(sharedProvider.models?.length, 1);
    assert.equal(sharedProvider.models?.[0]?.id, 'lfm-aa1');
    assert.equal(sharedProvider.models?.[0]?.reasoning, true);

    const dualProvider = buildFactoryProviderConfig({
      ...cfg,
      orchestratorModelId: 'lfm-omni',
      subagentModelId: 'lfm-aa1',
    });
    assert.equal(dualProvider.models?.length, 2);
    assert.deepEqual(dualProvider.models?.[0]?.input, ['text', 'image']);
    assert.deepEqual(dualProvider.models?.[1]?.input, ['text']);
  });

  it('resolves API key from env first, then ~/.pi/agent/models.json', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'factory-home-'));
    tempDirs.push(fakeHome);
    const agentDir = join(fakeHome, '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({ providers: { desktop: { apiKey: 'from-models-json' } } }),
    );

    assert.equal(resolveLlamaApiKey(fakeHome), 'from-models-json');

    process.env.FACTORY_LLAMA_API_KEY = 'from-env';
    assert.equal(resolveLlamaApiKey(fakeHome), 'from-env');
  });
});
