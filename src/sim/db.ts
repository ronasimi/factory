import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type EpisodeType =
  | 'tool_parse_error'
  | 'turn_retry'
  | 'token_cap'
  | 'subagent_blocked'
  | 'user_steering';

export type PatchTargetKind = 'system_prompt' | 'tool_description' | 'compaction_template';
export type PatchStatus = 'proposed' | 'accepted' | 'rejected' | 'reverted';

export interface SimEpisodeInput {
  projectKey: string;
  sessionId: string;
  conversationId?: string;
  taskId?: string;
  phase: string;
  modelId: string;
  episodeType: EpisodeType;
  toolName?: string;
  diagnostic: string;
  contextFingerprint?: string;
}

export interface SimProblemCluster {
  id: number;
  clusterKey: string;
  episodeType: EpisodeType;
  summary: string;
  occurrenceCount: number;
  lastSeenAt: number;
  status: 'open' | 'addressed' | 'monitoring';
}

export interface SimPatchRecord {
  id: number;
  clusterId: number;
  targetKind: PatchTargetKind;
  targetKey: string;
  patchText: string;
  rationale: string;
  predictedOutcome: string;
  authorModel: string;
  status: PatchStatus;
  createdAt: number;
  decidedAt: number | null;
}

export interface SimEvalRunInput {
  patchId: number;
  modelId: string;
  evalSuiteVersion: string;
  baselineScore: number;
  candidateScore: number;
  passed: boolean;
  observedOutcome: string;
  detailsJson: string;
}

export function resolveSimDbPath(homeDir = homedir()): string {
  const fromEnv = process.env.FACTORY_SIM_DB_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homeDir, '.pi', 'factory', 'sim.sqlite');
}

export class SimStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath = resolveSimDbPath()) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sim_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        task_id TEXT,
        phase TEXT NOT NULL,
        model_id TEXT NOT NULL,
        episode_type TEXT NOT NULL,
        tool_name TEXT,
        diagnostic TEXT NOT NULL,
        context_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_episodes_type ON sim_episodes(episode_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_sim_episodes_fp ON sim_episodes(context_fingerprint);

      CREATE TABLE IF NOT EXISTS sim_problem_clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_key TEXT NOT NULL UNIQUE,
        episode_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
      );

      CREATE TABLE IF NOT EXISTS sim_patches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id INTEGER NOT NULL REFERENCES sim_problem_clusters(id),
        target_kind TEXT NOT NULL,
        target_key TEXT NOT NULL,
        patch_text TEXT NOT NULL,
        rationale TEXT NOT NULL,
        predicted_outcome TEXT NOT NULL,
        author_model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sim_patches_status ON sim_patches(status, target_kind);

      CREATE TABLE IF NOT EXISTS sim_eval_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patch_id INTEGER NOT NULL REFERENCES sim_patches(id),
        model_id TEXT NOT NULL,
        eval_suite_version TEXT NOT NULL,
        baseline_score REAL NOT NULL,
        candidate_score REAL NOT NULL,
        passed INTEGER NOT NULL,
        observed_outcome TEXT NOT NULL,
        details_json TEXT NOT NULL,
        run_at INTEGER NOT NULL
      );
    `);
  }

  logEpisode(input: SimEpisodeInput, now = Date.now()): { episodeId: number; clusterId: number } {
    const fingerprint =
      input.contextFingerprint ?? `${input.episodeType}:${input.toolName ?? 'none'}:${input.phase}`;
    const diagnostic = input.diagnostic.slice(0, 500);

    const insertEpisode = this.db.prepare(`
      INSERT INTO sim_episodes (
        project_key, session_id, conversation_id, task_id, phase, model_id,
        episode_type, tool_name, diagnostic, context_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const epRes = insertEpisode.run(
      input.projectKey,
      input.sessionId,
      input.conversationId ?? null,
      input.taskId ?? null,
      input.phase,
      input.modelId,
      input.episodeType,
      input.toolName ?? null,
      diagnostic,
      fingerprint,
      now,
    );

    const upsertCluster = this.db.prepare(`
      INSERT INTO sim_problem_clusters (cluster_key, episode_type, summary, occurrence_count, last_seen_at, status)
      VALUES (?, ?, ?, 1, ?, 'open')
      ON CONFLICT(cluster_key) DO UPDATE SET
        occurrence_count = occurrence_count + 1,
        last_seen_at = excluded.last_seen_at,
        summary = excluded.summary
    `);
    upsertCluster.run(fingerprint, input.episodeType, diagnostic.slice(0, 200), now);

    const clusterRow = this.db
      .prepare('SELECT id FROM sim_problem_clusters WHERE cluster_key = ?')
      .get(fingerprint) as { id: number };

    return { episodeId: Number(epRes.lastInsertRowid), clusterId: clusterRow.id };
  }

  getOpenClusters(minOccurrences = 3): SimProblemCluster[] {
    const rows = this.db
      .prepare(
        `SELECT id, cluster_key, episode_type, summary, occurrence_count, last_seen_at, status
         FROM sim_problem_clusters
         WHERE status = 'open' AND occurrence_count >= ?
         ORDER BY occurrence_count DESC, last_seen_at DESC`,
      )
      .all(minOccurrences) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      clusterKey: String(r.cluster_key),
      episodeType: r.episode_type as EpisodeType,
      summary: String(r.summary),
      occurrenceCount: Number(r.occurrence_count),
      lastSeenAt: Number(r.last_seen_at),
      status: r.status as SimProblemCluster['status'],
    }));
  }

  getPatchesForCluster(clusterId: number): SimPatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, cluster_id, target_kind, target_key, patch_text, rationale,
                predicted_outcome, author_model, status, created_at, decided_at
         FROM sim_patches WHERE cluster_id = ? ORDER BY created_at DESC`,
      )
      .all(clusterId) as Array<Record<string, unknown>>;

    return rows.map(mapPatchRow);
  }

  getActivePatches(targetKind?: PatchTargetKind): SimPatchRecord[] {
    const sql = targetKind
      ? `SELECT id, cluster_id, target_kind, target_key, patch_text, rationale,
                predicted_outcome, author_model, status, created_at, decided_at
         FROM sim_patches WHERE status = 'accepted' AND target_kind = ? ORDER BY decided_at ASC`
      : `SELECT id, cluster_id, target_kind, target_key, patch_text, rationale,
                predicted_outcome, author_model, status, created_at, decided_at
         FROM sim_patches WHERE status = 'accepted' ORDER BY decided_at ASC`;

    const rows = (targetKind ? this.db.prepare(sql).all(targetKind) : this.db.prepare(sql).all()) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapPatchRow);
  }

  createPatch(
    input: {
      clusterId: number;
      targetKind: PatchTargetKind;
      targetKey: string;
      patchText: string;
      rationale: string;
      predictedOutcome: string;
      authorModel: string;
    },
    now = Date.now(),
  ): number {
    const res = this.db
      .prepare(
        `INSERT INTO sim_patches (
          cluster_id, target_kind, target_key, patch_text, rationale,
          predicted_outcome, author_model, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        input.clusterId,
        input.targetKind,
        input.targetKey,
        input.patchText,
        input.rationale,
        input.predictedOutcome,
        input.authorModel,
        now,
      );
    return Number(res.lastInsertRowid);
  }

  recordEvalAndDecide(evalInput: SimEvalRunInput, now = Date.now()): PatchStatus {
    const status: PatchStatus = evalInput.passed ? 'accepted' : 'rejected';
    this.db
      .prepare(
        `INSERT INTO sim_eval_runs (
          patch_id, model_id, eval_suite_version, baseline_score,
          candidate_score, passed, observed_outcome, details_json, run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evalInput.patchId,
        evalInput.modelId,
        evalInput.evalSuiteVersion,
        evalInput.baselineScore,
        evalInput.candidateScore,
        evalInput.passed ? 1 : 0,
        evalInput.observedOutcome,
        evalInput.detailsJson,
        now,
      );

    this.db
      .prepare('UPDATE sim_patches SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, now, evalInput.patchId);

    if (status === 'accepted') {
      const patch = this.db
        .prepare('SELECT cluster_id FROM sim_patches WHERE id = ?')
        .get(evalInput.patchId) as { cluster_id: number } | undefined;
      if (patch) {
        this.db
          .prepare("UPDATE sim_problem_clusters SET status = 'addressed' WHERE id = ?")
          .run(patch.cluster_id);
      }
    }

    return status;
  }

  getStats(): {
    episodes: number;
    openClusters: number;
    acceptedPatches: number;
    rejectedPatches: number;
  } {
    const episodes = Number((this.db.prepare('SELECT COUNT(*) AS c FROM sim_episodes').get() as { c: number }).c);
    const openClusters = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM sim_problem_clusters WHERE status = 'open'").get() as { c: number })
        .c,
    );
    const acceptedPatches = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM sim_patches WHERE status = 'accepted'").get() as { c: number }).c,
    );
    const rejectedPatches = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM sim_patches WHERE status = 'rejected'").get() as { c: number }).c,
    );
    return { episodes, openClusters, acceptedPatches, rejectedPatches };
  }

  close(): void {
    this.db.close();
  }
}

function mapPatchRow(r: Record<string, unknown>): SimPatchRecord {
  return {
    id: Number(r.id),
    clusterId: Number(r.cluster_id),
    targetKind: r.target_kind as PatchTargetKind,
    targetKey: String(r.target_key),
    patchText: String(r.patch_text),
    rationale: String(r.rationale),
    predictedOutcome: String(r.predicted_outcome),
    authorModel: String(r.author_model),
    status: r.status as PatchStatus,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
  };
}
