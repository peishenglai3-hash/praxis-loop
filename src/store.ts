import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { buildFtsQuery, buildSearchTerms, SEARCH_TERMS_VERSION } from "./memory-index.js";
import type { DecisionInput, MemoryCandidate, MemoryInput, MemoryRecord, TaskSpec } from "./types.js";

interface MemoryRow {
  id: string; repository_id: string; kind: string; body: string; search_terms: string;
  source_event_ids: string; status: string; created_at: string; revised_from: string | null;
}
interface EventRow { seq: number; id: string; repository_id: string; type: string; payload_json: string }

export class PraxisStore {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly ftsAvailable: boolean;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath, { timeout: 5000, enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT,
        repository_id TEXT NOT NULL, type TEXT NOT NULL, recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, base_commit TEXT NOT NULL,
        task_json TEXT NOT NULL, worktree_path TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, diff_hash TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS current_memories (
        id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, kind TEXT NOT NULL,
        body TEXT NOT NULL, search_terms TEXT NOT NULL, source_event_ids TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, revised_from TEXT,
        source_event_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_scopes (
        memory_id TEXT NOT NULL REFERENCES current_memories(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL, PRIMARY KEY(memory_id, repository_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projection_state (
        name TEXT PRIMARY KEY, last_seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS current_memories_repo_status ON current_memories(repository_id, status);
    `);
    let ftsAvailable = true;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, search_terms, tokenize = 'unicode61 tokenchars ''_''');");
    } catch {
      ftsAvailable = false;
    }
    this.ftsAvailable = ftsAvailable;
    this.rebuildMemoryProjection();
    this.rebuildSearchProjection();
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEvent(repositoryId: string, type: string, payload: unknown, runId: string | null = null): EventRow {
    const id = randomUUID();
    const recordedAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO events(id, run_id, repository_id, type, recorded_at, payload_json) VALUES(?, ?, ?, ?, ?, ?)")
      .run(id, runId, repositoryId, type, recordedAt, JSON.stringify(payload));
    return { id, seq: Number(result.lastInsertRowid), repository_id: repositoryId, type, payload_json: JSON.stringify(payload) };
  }

  appendEvent(repositoryId: string, type: string, payload: unknown, runId: string | null = null): string {
    return this.insertEvent(repositoryId, type, payload, runId).id;
  }

  createRun(task: TaskSpec, worktreePath: string): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO runs(id, repository_id, base_commit, task_json, worktree_path, state, revision, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'planning', 0, ?, ?)")
        .run(task.id, task.repositoryId, task.baseCommit, JSON.stringify(task), worktreePath, now, now);
      this.insertEvent(task.repositoryId, "run.started", { task, worktreePath }, task.id);
    });
  }

  updateRun(runId: string, state: string, eventType: string, payload: unknown, diffHash?: string): string {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT revision, repository_id FROM runs WHERE id = ?").get(runId) as { revision: number; repository_id: string } | undefined;
      if (!current) throw new Error(`Unknown run ${runId}`);
      const nextRevision = current.revision + 1;
      const now = new Date().toISOString();
      const sql = diffHash === undefined
        ? "UPDATE runs SET state = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?"
        : "UPDATE runs SET state = ?, revision = ?, updated_at = ?, diff_hash = ? WHERE id = ? AND revision = ?";
      const result = diffHash === undefined
        ? this.db.prepare(sql).run(state, nextRevision, now, runId, current.revision)
        : this.db.prepare(sql).run(state, nextRevision, now, diffHash, runId, current.revision);
      if (Number(result.changes) !== 1) throw new Error(`Run ${runId} changed concurrently`);
      return this.insertEvent(current.repository_id, eventType, payload, runId).id;
    });
  }

  getRun(runId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const events = this.db.prepare("SELECT seq, type, recorded_at, payload_json FROM events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ seq: number; type: string; recorded_at: string; payload_json: string }>;
    return { ...row, task: JSON.parse(String(row.task_json)), events: events.map((event) => ({ seq: event.seq, type: event.type, recordedAt: event.recorded_at, payload: JSON.parse(event.payload_json) })) };
  }

  listRuns(repositoryId: string, limit = 20): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT id, repository_id, base_commit, state, revision, created_at, updated_at, diff_hash, worktree_path FROM runs WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(repositoryId, limit) as Array<Record<string, unknown>>;
  }

  recordDecision(input: DecisionInput): string {
    return this.recordMemory({ ...input, kind: "decision" });
  }

  recordMemory(input: MemoryInput): string {
    return this.transaction(() => {
      if (!input.body.trim() || Buffer.byteLength(input.body, "utf8") > 16 * 1024) throw new Error("Memory body must be non-empty and at most 16 KiB");
      if (input.applicableRepositoryIds.some((scope) => scope !== input.repositoryId)) throw new Error("Memory scope is limited to its source repository in this release");
      this.validateMemorySources(input.repositoryId, input.sourceEventIds);
      const eventType = input.kind === "decision" ? "memory.decision" : "memory.created";
      const event = this.insertEvent(input.repositoryId, eventType, input);
      this.projectMemory({
        ...input,
        status: input.status ?? "active",
        sourceEventIds: [...new Set([...input.sourceEventIds, event.id])],
        sourceEventId: event.id,
      });
      this.advanceProjection(event.seq);
      return event.id;
    });
  }

  reviseMemory(id: string, input: MemoryInput): void {
    this.transaction(() => {
      const existing = this.db.prepare("SELECT id, repository_id, source_event_id FROM current_memories WHERE id = ? AND status IN ('active', 'candidate')").get(id) as { id: string; repository_id: string; source_event_id: string } | undefined;
      if (!existing) throw new Error(`No active memory with id ${id}`);
      if (input.repositoryId !== existing.repository_id) throw new Error("A memory can only be revised within its source repository");
      this.validateMemorySources(input.repositoryId, input.sourceEventIds);
      if (!input.body.trim() || Buffer.byteLength(input.body, "utf8") > 16 * 1024) throw new Error("Memory body must be non-empty and at most 16 KiB");
      const event = this.insertEvent(input.repositoryId, "memory.revision", { supersedes: id, memory: input });
      this.supersedeProjectedMemory(id, existing.source_event_id);
      this.projectMemory({ ...input, status: input.status ?? "active", sourceEventIds: [...new Set([...input.sourceEventIds, event.id])], revisedFrom: id, sourceEventId: event.id });
      this.advanceProjection(event.seq);
    });
  }

  approveMemory(id: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT repository_id, search_terms FROM current_memories WHERE id = ? AND status = 'candidate'").get(id) as { repository_id: string; search_terms: string } | undefined;
      if (!row) throw new Error(`No candidate memory with id ${id}`);
      const event = this.insertEvent(row.repository_id, "memory.approved", { memoryId: id });
      this.db.prepare("UPDATE current_memories SET status = 'active' WHERE id = ?").run(id);
      if (this.ftsAvailable) this.db.prepare("INSERT INTO memories_fts(memory_id, search_terms) VALUES(?, ?)").run(id, row.search_terms);
      this.advanceProjection(event.seq);
    });
  }

  revokeMemory(id: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT id, repository_id, source_event_id FROM current_memories WHERE id = ? AND status IN ('active', 'candidate')").get(id) as { id: string; repository_id: string; source_event_id: string } | undefined;
      if (!row) throw new Error(`No active or candidate memory with id ${id}`);
      const event = this.insertEvent(row.repository_id, "memory.revoke", { memoryId: id, sourceEventId: row.source_event_id });
      this.revokeProjectedMemory(id, row.source_event_id);
      this.advanceProjection(event.seq);
    });
  }

  recordExposure(repositoryId: string, runId: string, memoryIds: string[]): void {
    if (memoryIds.length > 0) this.appendEvent(repositoryId, "memory.exposed", { memoryIds }, runId);
  }

  searchMemories(query: string, repositoryId: string, permittedRepositoryIds: string[] = [repositoryId], limit = 50): MemoryCandidate[] {
    const built = buildFtsQuery(query);
    if (!built || limit < 1) return [];
    const allowedIds = [...new Set([repositoryId, ...permittedRepositoryIds])];
    const placeholders = allowedIds.map(() => "?").join(",");
    let rows: MemoryRow[];
    if (this.ftsAvailable) {
      try {
        rows = this.db.prepare(`
          SELECT m.id, m.repository_id, m.kind, m.body, m.search_terms, m.source_event_ids, m.status, m.created_at, m.revised_from
          FROM memories_fts f JOIN current_memories m ON m.id = f.memory_id
          WHERE memories_fts MATCH ? AND m.status = 'active'
            AND m.repository_id IN (${placeholders})
            AND EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id = m.id AND s.repository_id = ?)
          ORDER BY bm25(memories_fts) ASC LIMIT ?
        `).all(built.match, ...allowedIds, repositoryId, limit) as unknown as MemoryRow[];
      } catch {
        rows = this.searchByTerms(built.terms, repositoryId, allowedIds, limit);
      }
    } else {
      rows = this.searchByTerms(built.terms, repositoryId, allowedIds, limit);
    }
    return rows.map((row, index) => {
      const matchedTerms = built.terms.filter((term) => buildSearchTerms(row.body).split(" ").includes(term));
      const scopes = this.db.prepare("SELECT repository_id FROM memory_scopes WHERE memory_id = ? ORDER BY repository_id").all(row.id) as Array<{ repository_id: string }>;
      const memory: MemoryRecord = {
        id: row.id, repositoryId: row.repository_id, kind: row.kind as MemoryRecord["kind"], body: row.body,
        sourceEventIds: JSON.parse(row.source_event_ids) as string[], applicableRepositoryIds: scopes.map((scope) => scope.repository_id),
        status: row.status as MemoryRecord["status"], createdAt: row.created_at,
        ...(row.revised_from === null ? {} : { revisedFrom: row.revised_from }),
      };
      return { memory, rank: index + 1, matchedTerms, snippet: snippet(row.body, matchedTerms) };
    });
  }

  allMemories(repositoryId: string, includeHistory = false): MemoryRecord[] {
    const sql = includeHistory
      ? "SELECT * FROM current_memories WHERE repository_id = ? ORDER BY created_at DESC"
      : "SELECT * FROM current_memories WHERE repository_id = ? AND status = 'active' ORDER BY created_at DESC";
    const rows = this.db.prepare(sql).all(repositoryId) as unknown as MemoryRow[];
    return rows.map((row) => ({
      id: row.id, repositoryId: row.repository_id, kind: row.kind as MemoryRecord["kind"], body: row.body,
      sourceEventIds: JSON.parse(row.source_event_ids) as string[],
      applicableRepositoryIds: (this.db.prepare("SELECT repository_id FROM memory_scopes WHERE memory_id = ? ORDER BY repository_id").all(row.id) as Array<{ repository_id: string }>).map((scope) => scope.repository_id),
      status: row.status as MemoryRecord["status"], createdAt: row.created_at,
      ...(row.revised_from === null ? {} : { revisedFrom: row.revised_from }),
    }));
  }

  private searchByTerms(terms: string[], repositoryId: string, allowedIds: string[], limit: number): MemoryRow[] {
    const rows = this.db.prepare(`SELECT m.* FROM current_memories m WHERE m.status = 'active'
      AND m.repository_id IN (${allowedIds.map(() => "?").join(",")})
      AND EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id = m.id AND s.repository_id = ?)`)
      .all(...allowedIds, repositoryId) as unknown as MemoryRow[];
    return rows.map((row) => ({ ...row, overlap: terms.filter((term) => row.search_terms.split(" ").includes(term)).length }))
      .filter((row) => row.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap || right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }

  private projectMemory(input: MemoryInput & { sourceEventId: string }): void {
    const searchTerms = buildSearchTerms(input.body);
    this.db.prepare("INSERT INTO current_memories(id, repository_id, kind, body, search_terms, source_event_ids, status, created_at, revised_from, source_event_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.repositoryId, input.kind, input.body, searchTerms, JSON.stringify(input.sourceEventIds), input.status ?? "active", input.createdAt, input.revisedFrom ?? null, input.sourceEventId);
    const scopes = new Set(input.applicableRepositoryIds.length > 0 ? input.applicableRepositoryIds : [input.repositoryId]);
    for (const scope of scopes) this.db.prepare("INSERT INTO memory_scopes(memory_id, repository_id) VALUES(?, ?)").run(input.id, scope);
    if (this.ftsAvailable && (input.status ?? "active") === "active") this.db.prepare("INSERT INTO memories_fts(memory_id, search_terms) VALUES(?, ?)").run(input.id, searchTerms);
  }

  private validateMemorySources(repositoryId: string, sourceEventIds: string[]): void {
    if (new Set(sourceEventIds).size !== sourceEventIds.length) throw new Error("Memory source event IDs must be unique");
    if (sourceEventIds.length === 0) return;
    const placeholders = sourceEventIds.map(() => "?").join(",");
    const count = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE repository_id = ? AND id IN (${placeholders})`).get(repositoryId, ...sourceEventIds) as { count: number }).count);
    if (count !== sourceEventIds.length) throw new Error("Each memory source must be an existing event from the same repository");
  }

  private revokeProjectedMemory(memoryId: string, sourceEventId: string): void {
    this.invalidateProjectedMemory(memoryId, sourceEventId, "revoked");
  }

  private supersedeProjectedMemory(memoryId: string, sourceEventId: string): void {
    this.invalidateProjectedMemory(memoryId, sourceEventId, "superseded");
  }

  private invalidateProjectedMemory(memoryId: string, sourceEventId: string, rootStatus: "revoked" | "superseded"): void {
    const invalidatedIds = new Set([memoryId, sourceEventId].filter(Boolean));
    let changed = true;
    while (changed) {
      changed = false;
      const rows = this.db.prepare("SELECT id, source_event_id, source_event_ids FROM current_memories WHERE status IN ('active', 'candidate')").all() as unknown as Array<{ id: string; source_event_id: string; source_event_ids: string }>;
      for (const row of rows) {
        const sources = JSON.parse(row.source_event_ids) as string[];
        if (row.id !== memoryId && !sources.some((source) => invalidatedIds.has(source))) continue;
        this.db.prepare("UPDATE current_memories SET status = ? WHERE id = ?").run(row.id === memoryId ? rootStatus : "revoked", row.id);
        if (this.ftsAvailable) this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(row.id);
        invalidatedIds.add(row.id);
        invalidatedIds.add(row.source_event_id);
        changed = true;
      }
    }
  }

  private advanceProjection(seq: number): void {
    this.db.prepare("INSERT INTO projection_state(name, last_seq) VALUES('memories', ?) ON CONFLICT(name) DO UPDATE SET last_seq = excluded.last_seq")
      .run(seq);
  }

  private rebuildMemoryProjection(): void {
    const cursorRow = this.db.prepare("SELECT last_seq FROM projection_state WHERE name = 'memories'").get() as { last_seq: number } | undefined;
    const cursor = cursorRow?.last_seq ?? 0;
    const events = this.db.prepare("SELECT seq, id, repository_id, type, payload_json FROM events WHERE seq > ? AND type IN ('memory.decision', 'memory.created', 'memory.revision', 'memory.revoke') ORDER BY seq")
      .all(cursor) as unknown as EventRow[];
    if (events.length === 0) return;
    this.transaction(() => {
      for (const event of events) {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        if (event.type === "memory.decision" || event.type === "memory.created") {
          const input = payload as unknown as MemoryInput;
          this.projectMemory({ ...input, kind: input.kind ?? "decision", status: input.status ?? "active", sourceEventIds: [...new Set([...(input.sourceEventIds ?? []), event.id])], sourceEventId: event.id });
        } else if (event.type === "memory.revision") {
          const memory = payload.memory as MemoryInput;
          const oldId = String(payload.supersedes);
          const old = this.db.prepare("SELECT source_event_id FROM current_memories WHERE id = ?").get(oldId) as { source_event_id: string } | undefined;
          this.supersedeProjectedMemory(oldId, old?.source_event_id ?? "");
          this.projectMemory({ ...memory, kind: memory.kind ?? "decision", status: memory.status ?? "active", sourceEventIds: [...new Set([...(memory.sourceEventIds ?? []), event.id])], revisedFrom: oldId, sourceEventId: event.id });
        } else {
          this.revokeProjectedMemory(String(payload.memoryId), String(payload.sourceEventId));
        }
        this.advanceProjection(event.seq);
      }
    });
  }

  private rebuildSearchProjection(): void {
    const version = (this.db.prepare("SELECT value FROM store_meta WHERE key = 'search_terms_version'").get() as { value: string } | undefined)?.value;
    const active = this.db.prepare("SELECT id, body, search_terms FROM current_memories WHERE status = 'active'").all() as Array<{ id: string; body: string; search_terms: string }>;
    const staleTerms = version !== SEARCH_TERMS_VERSION || active.some((row) => row.search_terms !== buildSearchTerms(row.body));
    let staleFts = false;
    if (this.ftsAvailable) {
      const actual = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memories_fts").get() as { count: number }).count);
      const missingOrChanged = Number((this.db.prepare("SELECT COUNT(*) AS count FROM current_memories m LEFT JOIN memories_fts f ON f.memory_id = m.id WHERE m.status = 'active' AND (f.memory_id IS NULL OR f.search_terms != m.search_terms)").get() as { count: number }).count);
      const orphaned = Number((this.db.prepare("SELECT COUNT(*) AS count FROM memories_fts f LEFT JOIN current_memories m ON m.id = f.memory_id WHERE m.id IS NULL OR m.status != 'active'").get() as { count: number }).count);
      staleFts = actual !== active.length || missingOrChanged > 0 || orphaned > 0;
    }
    if (!staleTerms && !staleFts) return;
    this.transaction(() => {
      if (staleTerms) {
        const rows = this.db.prepare("SELECT id, body FROM current_memories").all() as Array<{ id: string; body: string }>;
        for (const row of rows) this.db.prepare("UPDATE current_memories SET search_terms = ? WHERE id = ?").run(buildSearchTerms(row.body), row.id);
        this.db.prepare("INSERT INTO store_meta(key, value) VALUES('search_terms_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SEARCH_TERMS_VERSION);
      }
      if (this.ftsAvailable) {
        this.db.exec("DELETE FROM memories_fts;");
        const rows = this.db.prepare("SELECT id, search_terms FROM current_memories WHERE status = 'active'").all() as Array<{ id: string; search_terms: string }>;
        for (const row of rows) this.db.prepare("INSERT INTO memories_fts(memory_id, search_terms) VALUES(?, ?)").run(row.id, row.search_terms);
      }
    });
  }
}

function snippet(body: string, terms: string[]): string {
  const lower = body.toLocaleLowerCase();
  const offsets = terms.map((term) => lower.indexOf(term.toLocaleLowerCase())).filter((index) => index >= 0);
  const start = offsets.length > 0 ? Math.max(0, Math.min(...offsets) - 70) : 0;
  return body.slice(start, Math.min(body.length, start + 220));
}
