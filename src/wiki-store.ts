import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Proposal, Snapshot } from "./wiki-types.js";
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
    if (filename !== ":memory:") chmodSync(filename, 0o600);
  }
  close() { this.db.close(); }
  get(id: string) { const row = this.db.prepare("SELECT payload FROM proposals WHERE id=?").get(id) as { payload: string } | undefined; return row ? JSON.parse(row.payload) as Proposal : null; }
  findSource(hash: string) { const row = this.db.prepare("SELECT payload FROM proposals WHERE source_hash=? AND status NOT IN ('rejected','stale') ORDER BY rowid DESC LIMIT 1").get(hash) as { payload: string } | undefined; return row ? JSON.parse(row.payload) as Proposal : null; }
  put(proposal: Proposal) { this.db.prepare("INSERT INTO proposals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,hash=excluded.hash,payload=excluded.payload").run(proposal.id, proposal.status, proposal.hash, proposal.snapshot.source_hash, JSON.stringify(proposal)); }
  list(status?: string) { const rows = status ? this.db.prepare("SELECT payload FROM proposals WHERE status=?").all(status) : this.db.prepare("SELECT payload FROM proposals").all(); return (rows as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Proposal); }
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
  pendingSnapshots() { return (this.db.prepare("SELECT payload FROM snapshots WHERE status='captured' ORDER BY rowid LIMIT 10").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Snapshot); }
  snapshotDone(hash: string, status: string) { this.db.prepare("UPDATE snapshots SET status=? WHERE hash=?").run(status, hash); }
}
