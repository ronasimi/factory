import { createModels, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CompactionHooks } from '@earendil-works/pi-durable';
import { FACTORY_PROVIDER_ID, type LlamaEndpointConfig } from './providers.ts';
import type { InstanceSlotPool } from './slots.ts';

export const DEFAULT_COMPACTION_TEMPLATE = `Summarize the conversation into a dense handoff state for the next turn.
Preserve exact file paths, symbol names, command outputs, and error messages.
Use this structure:
## Goal
## Constraints
## Done
## In Progress / Blocked
## Key Decisions
## Next Steps`;

export interface TriageResult {
  category: 'tool_parse' | 'build_error' | 'test_failure' | 'runtime_error' | 'blocked_subagent' | 'unknown';
  summary: string;
  rootCause: string;
  suggestedAction: string;
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

export function parseTriageJson(raw: string): TriageResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<TriageResult>;
    return {
      category: parsed.category ?? 'unknown',
      summary: typeof parsed.summary === 'string' ? parsed.summary : raw.slice(0, 300),
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : 'See raw diagnostic.',
      suggestedAction: typeof parsed.suggestedAction === 'string' ? parsed.suggestedAction : 'Inspect logs.',
    };
  } catch {
    return {
      category: 'unknown',
      summary: raw.slice(0, 300) || 'No triage output',
      rootCause: 'Non-JSON response from Instance triage',
      suggestedAction: 'Inspect raw diagnostic output.',
    };
  }
}

export function resolveInstanceModel(
  ctx: Pick<ExtensionContext, 'modelRegistry'>,
  endpoint: LlamaEndpointConfig,
): Model<'openai-completions'> | undefined {
  return ctx.modelRegistry.find(FACTORY_PROVIDER_ID, endpoint.subagentModelId) as
    | Model<'openai-completions'>
    | undefined;
}

export async function runInstanceCompletion(
  ctx: Pick<ExtensionContext, 'modelRegistry'>,
  endpoint: LlamaEndpointConfig,
  slots: InstanceSlotPool,
  priority: 'compaction' | 'utility' | 'sim',
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1024,
  signal?: AbortSignal,
): Promise<string> {
  const model = resolveInstanceModel(ctx, endpoint);
  if (!model) {
    throw new Error(`Instance model ${FACTORY_PROVIDER_ID}/${endpoint.subagentModelId} not found in registry`);
  }

  const models = createModels();
  return slots.run(
    priority,
    async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      const apiKey = auth.ok ? (auth.apiKey ?? endpoint.apiKey) : endpoint.apiKey;
      const headers = auth.ok ? auth.headers : undefined;
      const response = await models.completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
        },
        { apiKey, headers, maxTokens, temperature: 0.1, signal },
      );
      return extractText(response);
    },
    signal,
  );
}

/**
 * Durable CompactionHooks.beforeCompact factory that delegates summarization
 * to `Instance` through the 3-slot semaphore.
 */
export function createDurableCompactionHook(
  getContext: () => Pick<ExtensionContext, 'modelRegistry'> | undefined,
  endpoint: LlamaEndpointConfig,
  slots: InstanceSlotPool,
  getTemplate: () => string = () => DEFAULT_COMPACTION_TEMPLATE,
): CompactionHooks['beforeCompact'] {
  return async (compaction, _api, _ctx) => {
    const extCtx = getContext();
    if (!extCtx) return { decline: true };

    const serialized = compaction.messages
      .map((m) => {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join('\n');
        return `[${m.role}] ${text.slice(0, 2000)}`;
      })
      .join('\n\n');

    const prompt = [
      getTemplate(),
      compaction.instructions ? `Additional instructions: ${compaction.instructions}` : '',
      'Conversation to compact:',
      serialized,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const summary = await runInstanceCompletion(
        extCtx,
        endpoint,
        slots,
        'compaction',
        'You are a precise technical compaction assistant. Output only the structured summary.',
        prompt,
        2048,
      );
      return summary ? { summary } : { decline: true };
    } catch {
      return { decline: true };
    }
  };
}

export function registerUtilityHooks(
  pi: ExtensionAPI,
  endpoint: LlamaEndpointConfig,
  slots: InstanceSlotPool,
): void {
  pi.registerCommand('factory-slots', {
    description: 'Show factory Singleton/Instance slot usage',
    handler: async (_args, ctx) => {
      const s = slots.stats;
      ctx.ui.notify(
        `factory slots — Singleton: 1 | Instance: ${s.active}/${s.capacity} active, ${s.queued} queued`,
        'info',
      );
    },
  });

  pi.registerCommand('factory-triage', {
    description: 'Triage an error log or diff snippet using Instance (lfm-aa1)',
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify('Usage: /factory-triage <error-or-log-snippet>', 'warning');
        return;
      }
      const raw = await runInstanceCompletion(
        ctx,
        endpoint,
        slots,
        'utility',
        'Extract a JSON object with keys: category, summary, rootCause, suggestedAction. Output JSON only.',
        input,
        512,
      );
      const triage = parseTriageJson(raw);
      ctx.ui.notify(`[${triage.category}] ${triage.summary} -> ${triage.suggestedAction}`, 'info');
    },
  });
}
