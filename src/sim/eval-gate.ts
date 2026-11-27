import type { PatchTargetKind, SimPatchRecord } from './db.ts';

export const EVAL_SUITE_VERSION = '1.0.0';

export interface MicroEvalResult {
  baselineScore: number;
  candidateScore: number;
  passed: boolean;
  observedOutcome: string;
  detailsJson: string;
}

/**
 * Lightweight deterministic micro-eval gate for SIM patches.
 * Validates patch safety, non-duplication, length budget, and structural invariants
 * before allowing a prompt, tool-description, or compaction-template patch into active state.
 */
export function runLocalMicroEval(candidate: {
  targetKind: PatchTargetKind;
  targetKey: string;
  patchText: string;
  rationale: string;
  predictedOutcome: string;
  priorPatches: SimPatchRecord[];
}): MicroEvalResult {
  const checks: Array<{ name: string; ok: boolean; weight: number }> = [];
  const text = candidate.patchText.trim();

  checks.push({
    name: 'non_empty_within_budget',
    ok: text.length >= 16 && text.length <= 1200,
    weight: 0.3,
  });

  checks.push({
    name: 'has_rationale_and_prediction',
    ok: candidate.rationale.trim().length >= 10 && candidate.predictedOutcome.trim().length >= 10,
    weight: 0.25,
  });

  // Never repeat an already-rejected identical or near-identical patch
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const duplicatesRejected = candidate.priorPatches.some(
    (p) => p.status === 'rejected' && p.patchText.trim().toLowerCase().replace(/\s+/g, ' ') === normalized,
  );
  checks.push({
    name: 'not_duplicate_rejected',
    ok: !duplicatesRejected,
    weight: 0.25,
  });

  // Target-specific structural invariants
  const targetOk =
    candidate.targetKind === 'compaction_template'
      ? /goal|next|block|file/i.test(text)
      : !/<tool_call>|<\/think>/i.test(text);
  checks.push({
    name: 'target_invariants',
    ok: targetOk,
    weight: 0.2,
  });

  const baselineScore = 0.7;
  const candidateScore = Number(
    checks.reduce((acc, c) => acc + (c.ok ? c.weight : 0), 0).toFixed(3),
  );
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const passed = failed.length === 0 && candidateScore >= baselineScore;

  return {
    baselineScore,
    candidateScore,
    passed,
    observedOutcome: passed
      ? `Passed all ${checks.length} micro-eval checks (score=${candidateScore}).`
      : `Rejected by micro-eval gate; failed checks: ${failed.join(', ')} (score=${candidateScore}).`,
    detailsJson: JSON.stringify({ checks }),
  };
}
