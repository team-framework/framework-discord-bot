import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Proposal, Snapshot } from "./wiki-types.js";
import type { GenerationUsage } from "./wiki-proposer.js";
export class ProposalStore {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,status TEXT NOT NULL,hash TEXT NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,leased_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'captured');`);
    this.db.exec("CREATE TABLE IF NOT EXISTS generation_metrics(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,release TEXT NOT NULL,outcome TEXT NOT NULL,message_count INTEGER NOT NULL,latency_ms REAL NOT NULL,facts TEXT NOT NULL)");
    if (!(this.db.prepare("PRAGMA table_info(snapshots)").all() as Array<{name: string}>).some((column) => column.name === "leased_until")) this.db.exec("ALTER TABLE snapshots ADD COLUMN leased_until INTEGER NOT NULL DEFAULT 0");
    if (!(this.db.prepare("PRAGMA table_info(snapshots)").all() as Array<{name: string}>).some((column) => column.name === "generation_token")) this.db.exec("ALTER TABLE snapshots ADD COLUMN generation_token TEXT");
    if (filename !== ":memory:") chmodSync(filename, 0o600);
  }
  close() { this.db.close(); }
  recordGeneration(outcome: 'proposed' | 'no_update' | 'error', messageCount: number, latencyMs: number, usage: GenerationUsage | null) {
    this.db.prepare('INSERT INTO generation_metrics VALUES(?,?,?,?,?,?,?)').run(randomUUID(), Date.now(), process.env.WIKI_MEASUREMENT_RELEASE || 'unversioned', outcome, messageCount, latencyMs, JSON.stringify(usage || {}));
  }
  get(id: string) { const row = this.db.prepare("SELECT payload FROM proposals WHERE id=?").get(id) as { payload: string } | undefined; return row ? JSON.parse(row.payload) as Proposal : null; }
  findSource(hash: string) { const row = this.db.prepare("SELECT payload FROM proposals WHERE source_hash=? AND status NOT IN ('rejected','stale') ORDER BY rowid DESC LIMIT 1").get(hash) as { payload: string } | undefined; return row ? JSON.parse(row.payload) as Proposal : null; }
  put(proposal: Proposal) { this.db.prepare("INSERT INTO proposals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,hash=excluded.hash,payload=excluded.payload").run(proposal.id, proposal.status, proposal.hash, proposal.snapshot.source_hash, JSON.stringify(proposal)); }
  list(status?: string) { const rows = status ? this.db.prepare("SELECT payload FROM proposals WHERE status=?").all(status) : this.db.prepare("SELECT payload FROM proposals").all(); return (rows as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Proposal); }
  recordNotice(expected: Proposal, noticeId: string, state?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(expected.id); if (!current) throw new Error("제안을 찾지 못했어요.");
      const matches = current.hash === expected.hash && current.version === expected.version && current.status === expected.status;
      current.notice_id ??= noticeId;
      if (matches && current.notice_id === noticeId && state) current.notice_state = state;
      else if (!matches) current.notice_state = undefined;
      this.put(current); this.db.exec("COMMIT"); return { current, matches };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  transition(id: string, hash: string, status: "rejected" | "revising") {
    this.db.exec("BEGIN IMMEDIATE");
    try { const proposal = this.get(id); if (!proposal || proposal.hash !== hash || proposal.status !== "pending") throw new Error("제안이 바뀌었거나 이미 처리됐어요."); proposal.status = status;
      if (status === "revising") proposal.revision_started_at = Date.now(); this.put(proposal); this.db.exec("COMMIT"); return proposal; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  approve(id: string, hash: string, actor: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.get(id);
      if (!proposal || proposal.hash !== hash || proposal.status !== "pending") throw new Error("제안이 바뀌었거나 이미 처리됐어요.");
      proposal.status = "approved"; proposal.approved_by = actor; proposal.approved_at = new Date().toISOString(); this.put(proposal);
      this.db.prepare("INSERT INTO outbox(id) VALUES(?) ON CONFLICT DO NOTHING").run(id); this.db.exec("COMMIT"); return proposal;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  claim(now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const row = this.db.prepare("SELECT id FROM outbox WHERE leased_until<? AND next_at<=? ORDER BY rowid LIMIT 1").get(now, now) as { id: string } | undefined;
      if (row) this.db.prepare("UPDATE outbox SET leased_until=?,attempts=attempts+1 WHERE id=?").run(now + 10 * 60_000, row.id);
      this.db.exec("COMMIT"); return row ? this.get(row.id) : null;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finish(proposal: Proposal) { this.db.exec("BEGIN IMMEDIATE"); try { this.put(proposal); this.db.prepare("DELETE FROM outbox WHERE id=?").run(proposal.id); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  retry(id: string, now = Date.now()) { this.db.prepare("UPDATE outbox SET leased_until=0,next_at=? WHERE id=?").run(now + 60_000, id); }
  state<T>(key: string): T | null { const row = this.db.prepare("SELECT payload FROM state WHERE key=?").get(key) as { payload: string } | undefined; return row ? JSON.parse(row.payload) as T : null; }
  saveState(key: string, value: unknown) { this.db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(key, JSON.stringify(value)); }
  capture(snapshot: Snapshot, cursorKey?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.prepare("INSERT INTO snapshots(hash,payload) VALUES(?,?) ON CONFLICT DO NOTHING").run(snapshot.source_hash, JSON.stringify(snapshot));
      if (cursorKey) this.saveState(cursorKey, snapshot.through_id); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  acquireGeneration(hash: string, now = Date.now()) { const token = randomUUID(); return this.db.prepare("UPDATE snapshots SET leased_until=?,generation_token=? WHERE hash=? AND leased_until<=?").run(now + 10 * 60_000, token, hash, now).changes === 1 ? token : null; }
  generationActive(hash: string, now = Date.now()) { return Boolean(this.db.prepare("SELECT hash FROM snapshots WHERE hash=? AND leased_until>?").get(hash, now)); }
  releaseGeneration(hash: string, token: string) { this.db.prepare("UPDATE snapshots SET leased_until=0,generation_token=NULL WHERE hash=? AND generation_token=?").run(hash, token); }
  completeGeneration(hash: string, token: string, proposal: Proposal | null, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.prepare("SELECT hash FROM snapshots WHERE hash=? AND generation_token=? AND leased_until>?").get(hash, token, now);
      if (!owned) throw new Error("제안 생성 예약이 만료됐어요. 새 결과를 다시 확인해 주세요.");
      if (proposal) this.put(proposal); this.snapshotDone(hash, proposal ? "proposed" : "no_update"); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pendingSnapshots() { return (this.db.prepare("SELECT payload FROM snapshots WHERE status='captured' AND leased_until<=? ORDER BY rowid LIMIT 10").all(Date.now()) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Snapshot); }
  snapshotDone(hash: string, status: string) { this.db.prepare("UPDATE snapshots SET status=? WHERE hash=?").run(status, hash); }
}
