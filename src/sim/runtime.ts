import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LlamaEndpointConfig } from '../extension/providers.ts';
import type { InstanceSlotPool } from '../extension/slots.ts';
import type { SimStore } from './db.ts';
import { reflectAndEvaluateClusters } from './reflector.ts';

export const DEFAULT_SIM_IDLE_MS = 5 * 60 * 1000; // 5 minutes

export function resolveSimIdleMs(): number {
  const raw = process.env.FACTORY_SIM_IDLE_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 100) return parsed;
  }
  return DEFAULT_SIM_IDLE_MS;
}

export class SimIdleScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeAbort: AbortController | undefined;
  private readonly idleMs: number;
  private readonly onIdle: (signal: AbortSignal) => Promise<void>;

  constructor(idleMs: number, onIdle: (signal: AbortSignal) => Promise<void>) {
    this.idleMs = idleMs;
    this.onIdle = onIdle;
  }

  touch(): void {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = undefined;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      const ac = new AbortController();
      this.activeAbort = ac;
      void this.onIdle(ac.signal).finally(() => {
        if (this.activeAbort === ac) this.activeAbort = undefined;
      });
    }, this.idleMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
  }
}

export function registerSimRuntime(
  pi: ExtensionAPI,
  store: SimStore,
  endpoint: LlamaEndpointConfig,
  slots: InstanceSlotPool,
): { dispose: () => void } {
  let latestCtx: ExtensionContext | undefined;

  const scheduler = new SimIdleScheduler(resolveSimIdleMs(), async (signal) => {
    await reflectAndEvaluateClusters({
      store,
      ctx: latestCtx,
      endpoint,
      slots,
      modelId: endpoint.subagentModelId,
      signal,
    });
  });

  // Reset idle timer on any user or agent activity
  pi.on('session_start', async (_e, ctx) => {
    latestCtx = ctx;
    scheduler.touch();
  });
  pi.on('input', async (_e, ctx) => {
    latestCtx = ctx;
    scheduler.touch();
  });
  pi.on('turn_start', async (_e, ctx) => {
    latestCtx = ctx;
    scheduler.touch();
  });
  pi.on('tool_execution_start', async (_e, ctx) => {
    latestCtx = ctx;
    scheduler.touch();
  });
  pi.on('session_shutdown', async () => {
    scheduler.dispose();
  });

  // Inject accepted system_prompt SIM patches into model context
  pi.on('context_with_system', async (event) => {
    const patches = store.getActivePatches('system_prompt');
    if (patches.length === 0) return;

    const already = event.messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[factory SIM active patches]'),
    );
    if (already) return;

    const block = [
      '[factory SIM active patches]',
      ...patches.map((p) => `- (${p.targetKey}): ${p.patchText}`),
    ].join('\n');

    return {
      messages: [...event.messages, { role: 'system' as const, content: block, timestamp: Date.now() }],
    };
  });

  // /sim command for inspection & manual reflection
  pi.registerCommand('sim', {
    description: 'Inspect or run Self-Improvement Memory (status | reflect)',
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const sub = args.trim().split(/\s+/)[0] || 'status';
      if (sub === 'reflect') {
        const res = await reflectAndEvaluateClusters({
          store,
          ctx,
          endpoint,
          slots,
          modelId: endpoint.subagentModelId,
        });
        ctx.ui.notify(
          `SIM reflect: proposed=${res.proposed}, accepted=${res.accepted}, rejected=${res.rejected}`,
          'info',
        );
        return;
      }
      const s = store.getStats();
      ctx.ui.notify(
        `SIM (${store.dbPath}): episodes=${s.episodes}, openClusters=${s.openClusters}, accepted=${s.acceptedPatches}, rejected=${s.rejectedPatches}`,
        'info',
      );
    },
  });

  return { dispose: () => scheduler.dispose() };
}
