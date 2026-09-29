import { createHash } from "node:crypto";
export const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export type SourceMessage = { id: string; author_id: string; bot: boolean; webhook: boolean; content: string; timestamp: string; edited_timestamp: string | null;
  reply_to: string | null; attachments: Array<{ id: string; filename: string; size: number; url: string; content_type: string | null }>; link: string };
export type Snapshot = { guild_id: string; channel_id: string; channel_name: string; messages: SourceMessage[]; participants: string[];
  from_id: string; through_id: string; source_hash: string; captured_at: string; omissions: string[] };
export type WikiChange = { path: string; before_blob: string | null; before_hash: string | null; before_content: string; after_content: string; after_hash: string; diff: string };
export type ProposalStatus = "pending" | "revising" | "approved" | "published" | "rejected" | "stale";
export type Proposal = { id: string; version: number; hash: string; status: ProposalStatus; snapshot: Snapshot; conclusion: string; uncertainties: string[];
  changes: WikiChange[]; base_commit: string; created_at: string; notice_id?: string; notice_state?: string; revision_started_at?: number; approved_by?: string; approved_at?: string; pr_url?: string; reason?: string };
export function proposalHash(proposal: Pick<Proposal, "id" | "version" | "snapshot" | "conclusion" | "uncertainties" | "changes" | "base_commit">) {
  return digest({ id: proposal.id, version: proposal.version, source: proposal.snapshot.source_hash, conclusion: proposal.conclusion,
    uncertainties: proposal.uncertainties, base: proposal.base_commit,
    changes: proposal.changes.map((change) => ({ path: change.path, before: change.before_hash, blob: change.before_blob, after: change.after_hash,
      exact_before: digest(change.before_content), exact_after: digest(change.after_content), exact_diff: digest(change.diff) })) });
}
export class StaleProposalError extends Error {}
