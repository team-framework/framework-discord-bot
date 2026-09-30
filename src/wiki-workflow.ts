import { discordApiRequest, editInteractionResponse, sendInteractionCallback } from "./discord.js";
import type { WikiConfig } from "./wiki-config.js";
import { WikiCoauthorError, WikiGitHub } from "./wiki-github.js";
import { WikiProposer, type GenerationUsage } from "./wiki-proposer.js";
import { DiscordSources } from "./wiki-snapshot.js";
import { ProposalStore } from "./wiki-store.js";
import { digest, proposalHash, StaleProposalError, type Proposal, type Snapshot } from "./wiki-types.js";

export const WIKI_PROPOSAL_COMMAND = "위키-제안";
export function wikiProposalCommandDefinition(maxMessages = 300) {
  return { name: WIKI_PROPOSAL_COMMAND, description: "현재 채널·공개 스레드의 논의를 위키 변경안으로 만들어요.", type: 1, dm_permission: false,
    options: [
      { name: "시작", description: "시작 메시지 ID (포함)", type: 3 },
      { name: "끝", description: "끝 메시지 ID (포함)", type: 3 },
      { name: "개수", description: "최근 메시지 개수 (기본 100)", type: 4, min_value: 1, max_value: maxMessages }
    ] };
}
export function proposalDocument(proposal: Proposal) {
  return [`# 위키 변경 제안 ${proposal.version}판`, proposal.conclusion,
    "## 불확실성과 미열람 범위", ...[...proposal.uncertainties, ...proposal.snapshot.omissions].map((item) => `- ${item}`),
    "## 읽은 범위", `- ${proposal.snapshot.messages.length}개 메시지`, `- ${proposal.snapshot.messages[0].link}`, `- ${proposal.snapshot.messages.at(-1)!.link}`,
    ...proposal.changes.flatMap((change) => [`## ${change.path}`, "변경 전 SHA256: " + (change.before_hash ?? "새 문서"), "변경 후 SHA256: " + change.after_hash,
      "```diff", change.diff, "```", "### 적용 후 문서 전체", change.after_content])].join("\n\n");
}
function buttonId(action: string, proposal: Proposal) { return `wiki:${action}:${proposal.id}:${proposal.hash.slice(0, 16)}`; }
function noticeState(proposal: Proposal) { return digest([proposal.hash, proposal.status, proposal.pr_url ?? null, proposal.reason ?? null]); }
export class WikiWorkflow {
  readonly sources: DiscordSources; readonly github: WikiGitHub; readonly proposer: WikiProposer;
  private busy = false;
  constructor(readonly config: WikiConfig, readonly token: string, readonly store: ProposalStore, readonly fetchImpl = fetch) {
    this.sources = new DiscordSources(token, config, fetchImpl); this.github = new WikiGitHub(config, fetchImpl); this.proposer = new WikiProposer(config, this.github, fetchImpl);
  }
  async notice(proposal: Proposal, retry = 0) {
    proposal = this.store.get(proposal.id) ?? proposal;
    // Reconcile an uncertain POST after restart using its deterministic component IDs.
    if (!proposal.notice_id) {
      const recent = await this.sources.request(`/channels/${proposal.snapshot.channel_id}/messages?limit=100`) as any[];
      const existing = recent.find((message) => message.components?.some((row: any) => row.components?.some((button: any) => button.custom_id === buttonId("approve", proposal))));
      if (existing) proposal = this.store.recordNotice(proposal, existing.id).current;
    }
    const active = proposal.status === "pending";
    const resultLine = proposal.pr_url ? `\n[Draft PR 확인](${proposal.pr_url})` : proposal.reason ? `\n${proposal.reason}` : "";
    const payload = { content: `**위키 최종 결론 확인 · ${proposal.version}판**\n${proposal.conclusion.slice(0, 1_000)}\n\n${proposal.snapshot.messages.length}개 메시지의 논의와 첨부된 정확한 변경안을 확인해 주세요. 이 범위에 메시지를 남긴 팀원 누구나 승인할 수 있어요. 승인하면 위키 Draft PR을 만듭니다.${resultLine}`,
      allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: `wiki-proposal-${proposal.id}.md` }],
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: "결론과 변경안 승인", custom_id: buttonId("approve", proposal), disabled: !active },
        { type: 2, style: 2, label: "결론 수정", custom_id: buttonId("revise", proposal), disabled: !active },
        { type: 2, style: 4, label: "반영하지 않기", custom_id: buttonId("reject", proposal), disabled: !active }
      ] }], ...(!proposal.notice_id ? { nonce: proposal.id, enforce_nonce: true } : {}) };
    const form = new FormData(); form.set("payload_json", JSON.stringify(payload));
    form.set("files[0]", new Blob([proposalDocument(proposal)], { type: "text/markdown;charset=utf-8" }), `wiki-proposal-${proposal.id}.md`);
    const endpoint = `https://discord.com/api/v10/channels/${proposal.snapshot.channel_id}/messages${proposal.notice_id ? `/${proposal.notice_id}` : ""}`;
    const response = await this.fetchImpl(endpoint, { method: proposal.notice_id ? "PATCH" : "POST", headers: { Authorization: `Bot ${this.token}` }, body: form, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`위키 제안 안내에 실패했어요 (${response.status}).`);
    const message = await response.json() as any;
    const saved = this.store.recordNotice(proposal, message.id, noticeState(proposal));
    if (!saved.matches && retry < 1) await this.notice(saved.current, retry + 1);
  }
  async propose(snapshot: Snapshot, finalConclusion?: string, previous?: Proposal) {
    this.store.capture(snapshot);
    if (!previous) {
      const existing = this.store.findSource(snapshot.source_hash);
      if (existing) { this.store.snapshotDone(snapshot.source_hash, "proposed"); if (!existing.notice_id) await this.notice(existing); return this.store.get(existing.id)!; }
    }
    const generationToken = this.store.acquireGeneration(snapshot.source_hash);
    if (!generationToken) throw new Error("같은 대화 범위의 제안을 만들고 있어요. 잠시 후 다시 확인해 주세요.");
    const started = performance.now();
    let usage: GenerationUsage | null = null;
    let outcome: 'proposed' | 'no_update' | 'error' = 'error';
    try {
      const generated = await this.proposer.generate(snapshot, finalConclusion, previous, (value) => { usage = value; });
      this.store.completeGeneration(snapshot.source_hash, generationToken, generated);
      outcome = generated ? 'proposed' : 'no_update';
      if (!generated) return null;
      await this.notice(generated); return this.store.get(generated.id)!;
    } finally {
      try { this.store.recordGeneration(outcome, snapshot.messages.length, performance.now() - started, usage); }
      catch { console.error('위키 제안 계측 저장에 실패했어요.'); }
      this.store.releaseGeneration(snapshot.source_hash, generationToken);
    }
  }
  async handle(interaction: any) {
    const command = interaction.type === 2 && interaction.data?.name === WIKI_PROPOSAL_COMMAND;
    const component = [3, 5].includes(interaction.type) && interaction.data?.custom_id?.startsWith("wiki:");
    if (!command && !component) return false;
    try {
      if (command) {
        await this.defer(interaction);
        const options = Object.fromEntries((interaction.data.options || []).map((option: any) => [option.name, option.value]));
        const snapshot = await this.sources.capture(interaction.channel_id, { from: options["시작"], to: options["끝"], count: options["개수"] ?? 100 });
        const proposal = await this.propose(snapshot);
        await this.reply(interaction, proposal ? "같은 채널에 최종 결론과 위키 변경안을 올렸어요. 대화 참여자가 확인해 주세요." : "이 범위에서 위키에 새로 반영할 확정된 결정이나 사실을 찾지 못했어요.");
      } else {
        const [, action, id, hashPrefix] = interaction.data.custom_id.split(":");
        const proposal = this.store.get(id);
        if (!proposal || proposal.hash.slice(0, 16) !== hashPrefix || proposal.hash !== proposalHash(proposal)) throw new Error("제안이 바뀌었어요. 최신 제안에서 다시 확인해 주세요.");
        if (interaction.type === 3 && interaction.message?.id !== proposal.notice_id) throw new Error("원래 위키 제안 메시지에서 처리해 주세요.");
        this.sources.participant(proposal.snapshot, interaction);
        if (action === "revise" && interaction.type === 3) {
          if (proposal.status !== "pending") throw new Error("이미 처리된 제안이에요.");
          await sendInteractionCallback({ interactionId: interaction.id, interactionToken: interaction.token, payload: { type: 9, data: { custom_id: buttonId("revision", proposal), title: "최종 결론 수정",
            components: [{ type: 1, components: [{ type: 4, custom_id: "conclusion", label: "팀에서 확인할 최종 결론", style: 2, max_length: 2_000, min_length: 1, required: true, value: proposal.conclusion.slice(0, 2_000) }] }] } }, fetchImpl: this.fetchImpl });
          return true;
        }
        await this.defer(interaction);
        const actor = await this.sources.authorize(proposal.snapshot, interaction);
        if (action === "reject" && interaction.type === 3) {
          const rejected = this.store.transition(id, proposal.hash, "rejected"); rejected.reason = "참여자가 위키 반영을 거절했어요."; this.store.put(rejected); await this.notice(rejected); await this.reply(interaction, "이 변경안은 반영하지 않아요.");
        } else if (action === "revision" && interaction.type === 5) {
          const conclusion = interaction.data.components?.flatMap((row: any) => row.components || []).find((entry: any) => entry.custom_id === "conclusion")?.value?.trim();
          if (!conclusion || conclusion.length > 2_000) throw new Error("최종 결론을 입력해 주세요.");
          const revision = this.store.transition(id, proposal.hash, "revising");
          try { await this.sources.verify(revision.snapshot); const updated = await this.propose(revision.snapshot, conclusion, revision);
            if (!updated) { revision.status = "rejected"; revision.reason = "수정한 결론으로 반영할 변경을 찾지 못했어요."; this.store.put(revision); await this.notice(revision); }
          } catch (error) { revision.status = "pending"; this.store.put(revision); throw error; }
          await this.reply(interaction, "수정한 결론으로 새 변경안을 만들었어요. 최신 변경안을 다시 승인해 주세요.");
        } else if (action === "approve" && interaction.type === 3) {
          if (proposal.status !== "pending") { await this.reply(interaction, proposal.pr_url ? `이미 [Draft PR](${proposal.pr_url})을 만들었어요.` : "이미 처리 중이거나 끝난 제안이에요."); return true; }
          await this.sources.verify(proposal.snapshot); await this.github.verify(proposal);
          this.store.approve(id, proposal.hash, actor);
          await this.reply(interaction, "이 결론과 변경안을 승인했어요. 같은 변경으로 Draft PR을 만들고 결과를 여기에 표시할게요.");
          void this.work().catch(() => {});
        } else throw new Error("지원하지 않는 제안 동작이에요.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "위키 제안에 실패했어요.";
      if (error instanceof StaleProposalError && component) {
        const proposal = this.store.get(interaction.data.custom_id.split(":")[2]);
        if (proposal) { proposal.status = "stale"; proposal.reason = message; this.store.put(proposal); await this.notice(proposal).catch(() => {}); }
      }
      await this.reply(interaction, message).catch(async () => sendInteractionCallback({ interactionId: interaction.id, interactionToken: interaction.token,
        payload: { type: 4, data: { content: message, flags: 64, allowed_mentions: { parse: [] } } }, fetchImpl: this.fetchImpl }).catch(() => {}));
    }
    return true;
  }
  private defer(interaction: any) { return sendInteractionCallback({ interactionId: interaction.id, interactionToken: interaction.token, payload: { type: 5, data: { flags: 64 } }, fetchImpl: this.fetchImpl }); }
  private reply(interaction: any, content: string) { return editInteractionResponse({ applicationId: interaction.application_id, interactionToken: interaction.token, content: content.slice(0, 1_900), fetchImpl: this.fetchImpl }); }
  async work() {
    if (this.busy) return; this.busy = true;
    try {
      for (const revision of this.store.list("revising")) if ((revision.revision_started_at ?? 0) + 10 * 60_000 < Date.now() && !this.store.generationActive(revision.snapshot.source_hash)) { revision.status = "pending"; this.store.put(revision); }
      for (const proposal of this.store.list().filter((proposal) => proposal.notice_state !== noticeState(proposal))) await this.notice(proposal).catch(() => {});
      const proposal = this.store.claim();
      if (proposal) {
        try {
          if (proposal.hash !== proposalHash(proposal) || proposal.status !== "approved") throw new StaleProposalError("승인한 변경안이 바뀌었어요. 새 제안이 필요해요.");
          const existing = await this.github.findPublished(proposal);
          if (!existing) await this.sources.verify(proposal.snapshot);
          proposal.pr_url = existing ?? await this.github.publish(proposal); proposal.status = "published"; proposal.reason = undefined; this.store.finish(proposal);
          const finalKey = `finalized:${proposal.snapshot.channel_id}`;
          const prior = this.store.state<string>(finalKey);
          if (!prior || BigInt(prior) < BigInt(proposal.snapshot.through_id)) this.store.saveState(finalKey, proposal.snapshot.through_id);
          await this.notice(proposal);
        } catch (error) {
          if (error instanceof StaleProposalError) { proposal.status = "stale"; proposal.reason = error.message; this.store.finish(proposal); await this.notice(proposal).catch(() => {}); }
          else if (error instanceof WikiCoauthorError) { proposal.reason = error.message; this.store.put(proposal); this.store.retry(proposal.id); await this.notice(proposal).catch(() => {}); }
          else { this.store.retry(proposal.id); console.error("위키 PR 생성 재시도를 예약했어요."); }
        }
      }
      for (const snapshot of this.store.pendingSnapshots()) { try { await this.propose(snapshot); } catch { console.error("저장된 위키 논의 제안 재시도를 예약했어요."); break; } }
    } finally { this.busy = false; }
  }
  async register(applicationId: string) { return discordApiRequest({ token: this.token, path: `/applications/${applicationId}/guilds/${this.config.guildId}/commands`, method: "POST", body: wikiProposalCommandDefinition(this.config.snapshotMessages), fetchImpl: this.fetchImpl }); }
}
