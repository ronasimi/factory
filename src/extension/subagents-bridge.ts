import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { FACTORY_PROVIDER_ID, type LlamaEndpointConfig } from './providers.ts';
import type { InstanceSlotPool } from './slots.ts';

const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'agent', 'subagent', 'durable_subagent']);

export function resolveDefaultSubagentModelRef(endpoint: LlamaEndpointConfig): string {
  return `${FACTORY_PROVIDER_ID}/${endpoint.subagentModelId}`;
}

export function applyDefaultSubagentModel(
  toolName: string,
  input: Record<string, unknown>,
  defaultModelRef: string,
): Record<string, unknown> {
  if (!SUBAGENT_TOOL_NAMES.has(toolName)) return input;
  if (typeof input.model === 'string' && input.model.trim().length > 0) return input;
  return { ...input, model: defaultModelRef };
}

export const FACTORY_SUBAGENT_GUIDANCE = [
  '[factory dual-model routing]',
  'Subagents run on the Instance worker model (3 concurrent slots max) and must conclude with an explicit `COMPLETE:` or `BLOCKED:` status block.',
  'Never spawn more than 3 concurrent background subagents; prefer direct core tools (`read`, `write`, `edit`, `bash`) for targeted single-file edits.',
].join(' ');

export function registerSubagentBridge(
  pi: ExtensionAPI,
  endpoint: LlamaEndpointConfig,
  _slots: InstanceSlotPool,
): void {
  const defaultModelRef = resolveDefaultSubagentModelRef(endpoint);

  // Inject default Instance model into subagent tool calls when omitted.
  pi.on('tool_call', async (event) => {
    if (!SUBAGENT_TOOL_NAMES.has(event.toolName)) return;
    if (event.input && typeof event.input === 'object') {
      const updated = applyDefaultSubagentModel(
        event.toolName,
        event.input as Record<string, unknown>,
        defaultModelRef,
      );
      if (updated !== event.input) {
        Object.assign(event.input as Record<string, unknown>, updated);
      }
    }
  });

  // Remind the orchestrator of the 3-slot budget and COMPLETE/BLOCKED contract.
  pi.on('context_with_system', async (event) => {
    const alreadyInjected = event.messages.some(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('[factory dual-model routing]'),
    );
    if (alreadyInjected) return;
    return {
      messages: [
        ...event.messages,
        { role: 'system' as const, content: FACTORY_SUBAGENT_GUIDANCE, timestamp: Date.now() },
      ],
    };
  });
}
