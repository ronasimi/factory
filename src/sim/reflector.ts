import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LlamaEndpointConfig } from '../extension/providers.ts';
import type { InstanceSlotPool } from '../extension/slots.ts';
import { runInstanceCompletion } from '../extension/utilities.ts';
import type { PatchTargetKind, SimProblemCluster, SimStore } from './db.ts';
import { EVAL_SUITE_VERSION, runLocalMicroEval } from './eval-gate.ts';

export interface PatchProposal {
  targetKind: PatchTargetKind;
  targetKey: string;
  patchText: string;
  rationale: string;
  predictedOutcome: string;
}

export function buildDeterministicFallbackProposal(cluster: SimProblemCluster): PatchProposal {
  switch (cluster.episodeType) {
    case 'tool_parse_error':
      return {
        targetKind: 'system_prompt',
        targetKey: 'tool_calling_hygiene',
        patchText:
          'When calling tools, emit strictly valid schema arguments and verify required fields before invoking.',
        rationale: `Recurring tool parse/argument errors (${cluster.occurrenceCount}x): ${cluster.summary}`,
        predictedOutcome: 'Reduce invalid_arguments and XML/JSON parse retries on tool calls.',
      };
    case 'subagent_blocked':
      return {
        targetKind: 'system_prompt',
        targetKey: 'subagent_delegation_scope',
        patchText:
          'Provide explicit file paths, line ranges, and acceptance criteria in subagent prompts so workers do not hit BLOCKED.',
        rationale: `Recurring BLOCKED subagents (${cluster.occurrenceCount}x): ${cluster.summary}`,
        predictedOutcome: 'Increase first-pass COMPLETE rate on delegated subagent tasks.',
      };
    case 'token_cap':
      return {
        targetKind: 'compaction_template',
        targetKey: 'concise_handoff',
        patchText:
          '## Goal\n## Done\n## Blocked\n## Next Steps\nKeep each bullet under 20 words and preserve exact file paths.',
        rationale: `Recurring token cap hits (${cluster.occurrenceCount}x): ${cluster.summary}`,
        predictedOutcome: 'Reduce assistant length-cap truncations via tighter handoff summaries.',
      };
    default:
      return {
        targetKind: 'system_prompt',
        targetKey: `mitigate_${cluster.episodeType}`,
        patchText: `Watch for ${cluster.episodeType} patterns (${cluster.summary.slice(0, 80)}) and verify preconditions before acting.`,
        rationale: `Recurring ${cluster.episodeType} (${cluster.occurrenceCount}x)`,
        predictedOutcome: 'Lower repeat turn retries and user steering interruptions.',
      };
  }
}

export async function reflectAndEvaluateClusters(options: {
  store: SimStore;
  ctx?: Pick<ExtensionContext, 'modelRegistry'>;
  endpoint?: LlamaEndpointConfig;
  slots?: InstanceSlotPool;
  modelId: string;
  minOccurrences?: number;
  signal?: AbortSignal;
}): Promise<{ proposed: number; accepted: number; rejected: number }> {
  const clusters = options.store.getOpenClusters(options.minOccurrences ?? 3);
  let proposed = 0;
  let accepted = 0;
  let rejected = 0;

  for (const cluster of clusters) {
    if (options.signal?.aborted) break;
    const prior = options.store.getPatchesForCluster(cluster.id);
    if (prior.some((p) => p.status === 'accepted')) continue;

    let proposal: PatchProposal | undefined;
    if (options.ctx && options.endpoint && options.slots) {
      try {
        const priorSummary = prior
          .slice(0, 5)
          .map((p) => `- [${p.status}] ${p.patchText} (rationale: ${p.rationale})`)
          .join('\n');
        const raw = await runInstanceCompletion(
          options.ctx,
          options.endpoint,
          options.slots,
          'sim',
          'Propose a scoped harness patch as JSON with keys: targetKind (system_prompt|tool_description|compaction_template), targetKey, patchText, rationale, predictedOutcome. Output JSON only.',
          `Cluster (${cluster.episodeType}, ${cluster.occurrenceCount}x): ${cluster.summary}\nPrior attempts:\n${priorSummary || '(none)'}`,
          512,
          options.signal,
        );
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned) as Partial<PatchProposal>;
        if (parsed.patchText && parsed.rationale && parsed.predictedOutcome) {
          proposal = {
            targetKind: parsed.targetKind ?? 'system_prompt',
            targetKey: parsed.targetKey ?? cluster.clusterKey,
            patchText: parsed.patchText,
            rationale: parsed.rationale,
            predictedOutcome: parsed.predictedOutcome,
          };
        }
      } catch {
        // Fall back to deterministic proposal if Instance is unavailable or aborted.
      }
    }

    if (options.signal?.aborted) break;
    const finalProposal = proposal ?? buildDeterministicFallbackProposal(cluster);
    const patchId = options.store.createPatch({
      clusterId: cluster.id,
      targetKind: finalProposal.targetKind,
      targetKey: finalProposal.targetKey,
      patchText: finalProposal.patchText,
      rationale: finalProposal.rationale,
      predictedOutcome: finalProposal.predictedOutcome,
      authorModel: options.modelId,
    });
    proposed += 1;

    const evalRes = runLocalMicroEval({
      ...finalProposal,
      priorPatches: prior,
    });

    const decision = options.store.recordEvalAndDecide({
      patchId,
      modelId: options.modelId,
      evalSuiteVersion: EVAL_SUITE_VERSION,
      baselineScore: evalRes.baselineScore,
      candidateScore: evalRes.candidateScore,
      passed: evalRes.passed,
      observedOutcome: evalRes.observedOutcome,
      detailsJson: evalRes.detailsJson,
    });

    if (decision === 'accepted') accepted += 1;
    else rejected += 1;
  }

  return { proposed, accepted, rejected };
}
