import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { SimStore } from '../src/sim/db.ts';
import { reflectAndEvaluateClusters } from '../src/sim/reflector.ts';
import { SimIdleScheduler } from '../src/sim/runtime.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Self-Improvement Memory (SIM)', () => {
  it('logs episodes, clusters recurring friction, and retains accepted & rejected patches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-sim-'));
    tempDirs.push(dir);
    const store = new SimStore(join(dir, 'sim.sqlite'));

    for (let i = 0; i < 3; i += 1) {
      store.logEpisode({
        projectKey: '/repo/a',
        sessionId: `s-${i}`,
        phase: 'tool_execution_end',
        modelId: 'lfm-aa1',
        episodeType: 'tool_parse_error',
        toolName: 'edit',
        diagnostic: 'invalid_arguments: missing oldText',
      });
    }

    const res = await reflectAndEvaluateClusters({
      store,
      modelId: 'lfm-aa1',
      minOccurrences: 3,
    });

    assert.equal(res.proposed, 1);
    assert.equal(res.accepted, 1);
    assert.equal(res.rejected, 0);

    // Also verify rejected patch retention
    const { clusterId } = store.logEpisode({
      projectKey: '/repo/b',
      sessionId: 's-4',
      phase: 'pi.durable.phase:request',
      modelId: 'lfm-aa1',
      episodeType: 'token_cap',
      diagnostic: 'Assistant turn hit token limit',
    });
    const badPatchId = store.createPatch({
      clusterId,
      targetKind: 'system_prompt',
      targetKey: 'bad',
      patchText: 'x', // fails micro-eval length budget
      rationale: 'short',
      predictedOutcome: 'short',
      authorModel: 'lfm-aa1',
    });
    const decision = store.recordEvalAndDecide({
      patchId: badPatchId,
      modelId: 'lfm-aa1',
      evalSuiteVersion: '1.0.0',
      baselineScore: 0.7,
      candidateScore: 0.2,
      passed: false,
      observedOutcome: 'Too short',
      detailsJson: '{}',
    });
    assert.equal(decision, 'rejected');

    const stats = store.getStats();
    assert.equal(stats.episodes, 4);
    assert.equal(stats.acceptedPatches, 1);
    assert.equal(stats.rejectedPatches, 1);
    assert.equal(store.getActivePatches('system_prompt').length, 1);
    store.close();
  });

  it('triggers idle reflection after timeout and aborts when touched again', async () => {
    let triggered = 0;
    let aborted = false;
    const scheduler = new SimIdleScheduler(50, async (signal) => {
      triggered += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      aborted = signal.aborted;
    });

    scheduler.touch();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(triggered, 1);
    // Touching while reflection is in-flight aborts it
    scheduler.touch();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(aborted, true);
    scheduler.dispose();
  });
});
