import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InstanceSlotPool } from '../src/extension/slots.ts';
import { applyDefaultSubagentModel } from '../src/extension/subagents-bridge.ts';
import { parseTriageJson } from '../src/extension/utilities.ts';

describe('InstanceSlotPool', () => {
  it('bounds concurrent executions to capacity=3 and respects priority', async () => {
    const pool = new InstanceSlotPool(3);
    let current = 0;
    let maxSeen = 0;
    const order: string[] = [];

    const tasks = [
      pool.run('utility', async () => {
        current += 1;
        maxSeen = Math.max(maxSeen, current);
        order.push('u1');
        await new Promise((r) => setTimeout(r, 30));
        current -= 1;
      }),
      pool.run('utility', async () => {
        current += 1;
        maxSeen = Math.max(maxSeen, current);
        order.push('u2');
        await new Promise((r) => setTimeout(r, 30));
        current -= 1;
      }),
      pool.run('utility', async () => {
        current += 1;
        maxSeen = Math.max(maxSeen, current);
        order.push('u3');
        await new Promise((r) => setTimeout(r, 30));
        current -= 1;
      }),
      // Queued while 3 slots are busy; sim is lower priority than subagent
      pool.run('sim', async () => {
        order.push('sim');
      }),
      pool.run('subagent', async () => {
        order.push('subagent');
      }),
    ];

    await Promise.all(tasks);
    assert.equal(maxSeen, 3);
    assert.equal(pool.stats.active, 0);
    assert.equal(pool.stats.queued, 0);
    assert.ok(order.indexOf('subagent') < order.indexOf('sim'));
  });

  it('aborts queued waiters cleanly without leaking slots', async () => {
    const pool = new InstanceSlotPool(1);
    const release = await pool.acquire('subagent');
    const ac = new AbortController();
    const pending = pool.acquire('sim', ac.signal);
    ac.abort();
    await assert.rejects(pending, /Aborted/);
    release();
    assert.equal(pool.stats.active, 0);
  });
});

describe('subagent routing and triage parsing', () => {
  it('injects default Instance model when omitted on Agent/subagent calls', () => {
    const injected = applyDefaultSubagentModel('Agent', { prompt: 'hello' }, 'factory-llama/lfm-aa1');
    assert.equal(injected.model, 'factory-llama/lfm-aa1');

    const preserved = applyDefaultSubagentModel(
      'Agent',
      { prompt: 'hello', model: 'custom/model' },
      'factory-llama/lfm-aa1',
    );
    assert.equal(preserved.model, 'custom/model');

    const untouched = applyDefaultSubagentModel('read', { path: 'a.ts' }, 'factory-llama/lfm-aa1');
    assert.equal(untouched.model, undefined);
  });

  it('parses fenced JSON triage output and falls back gracefully on invalid JSON', () => {
    const ok = parseTriageJson('```json\n{"category":"build_error","summary":"TS2353","rootCause":"bad key","suggestedAction":"fix key"}\n```');
    assert.equal(ok.category, 'build_error');
    assert.equal(ok.summary, 'TS2353');

    const fallback = parseTriageJson('plain text failure');
    assert.equal(fallback.category, 'unknown');
    assert.equal(fallback.summary, 'plain text failure');
  });
});
