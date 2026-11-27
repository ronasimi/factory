import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { EpisodeType, SimStore } from './db.ts';

export function classifyToolFailure(toolName: string, resultText: string): EpisodeType {
  const lower = resultText.toLowerCase();
  if (lower.includes('invalid_arguments') || lower.includes('parse') || lower.includes('xml')) {
    return 'tool_parse_error';
  }
  if (toolName === 'Agent' || toolName === 'subagent' || lower.includes('blocked:')) {
    return 'subagent_blocked';
  }
  return 'tool_parse_error';
}

export function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is { type: string; text?: string } => typeof p === 'object' && p !== null)
    .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join('\n');
}

export function registerSimCollector(
  pi: ExtensionAPI,
  store: SimStore,
  getModelId: () => string,
  projectKey = process.cwd(),
): void {
  pi.on('tool_execution_end', async (event, ctx) => {
    if (!event.isError) return;
    const text = extractResultText((event.result as { content?: unknown } | undefined)?.content);
    const episodeType = classifyToolFailure(event.toolName, text);
    store.logEpisode({
      projectKey,
      sessionId: ctx.sessionManager.getSessionId(),
      phase: 'tool_execution_end',
      modelId: getModelId(),
      episodeType,
      toolName: event.toolName,
      diagnostic: text || `Tool ${event.toolName} returned error`,
    });
  });

  pi.on('turn_end', async (event, ctx) => {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.role === 'assistant' && msg.stopReason === 'length') {
      store.logEpisode({
        projectKey,
        sessionId: ctx.sessionManager.getSessionId(),
        phase: 'pi.durable.phase:request',
        modelId: getModelId(),
        episodeType: 'token_cap',
        diagnostic: `Assistant turn hit token limit (turnIndex=${event.turnIndex})`,
      });
    } else if (event.turnIndex >= 2 && msg?.stopReason === 'error') {
      store.logEpisode({
        projectKey,
        sessionId: ctx.sessionManager.getSessionId(),
        phase: 'pi.durable.phase:retry',
        modelId: getModelId(),
        episodeType: 'turn_retry',
        diagnostic: msg.errorMessage ?? `Turn ${event.turnIndex} ended with error`,
      });
    }
  });

  pi.on('input', async (event, ctx) => {
    if (!ctx.isIdle()) {
      store.logEpisode({
        projectKey,
        sessionId: ctx.sessionManager.getSessionId(),
        phase: 'pi.durable.phase:steer',
        modelId: getModelId(),
        episodeType: 'user_steering',
        diagnostic: `User steered active run: ${event.text.slice(0, 200)}`,
      });
    }
  });
}
