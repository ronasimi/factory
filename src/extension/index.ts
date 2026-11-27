import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerFactoryProvider, SLOT_LIMITS } from './providers.ts';
import { InstanceSlotPool } from './slots.ts';
import { registerSubagentBridge } from './subagents-bridge.ts';
import { registerUtilityHooks } from './utilities.ts';
import { SimStore } from '../sim/db.ts';
import { registerSimCollector } from '../sim/collector.ts';
import { registerSimRuntime } from '../sim/runtime.ts';

export default function factoryExtension(pi: ExtensionAPI): void {
  const endpoint = registerFactoryProvider(pi);
  const slots = new InstanceSlotPool(SLOT_LIMITS.subagents);
  const simStore = new SimStore();

  registerSubagentBridge(pi, endpoint, slots);
  registerUtilityHooks(pi, endpoint, slots);
  registerSimCollector(pi, simStore, () => endpoint.orchestratorModelId);
  const simRuntime = registerSimRuntime(pi, simStore, endpoint, slots);

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI) {
      const s = simStore.getStats();
      ctx.ui.setStatus(
        'factory',
        `factory: ${endpoint.orchestratorModelId}(1)+${endpoint.subagentModelId}(${SLOT_LIMITS.subagents}) | sim:${s.acceptedPatches}✓/${s.rejectedPatches}✗`,
      );
    }
  });

  pi.on('session_shutdown', async () => {
    simRuntime.dispose();
    simStore.close();
  });
}
