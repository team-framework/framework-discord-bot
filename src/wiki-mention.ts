import { createHash } from "node:crypto";
import { isSnowflake, sendDiscordMessage } from "./discord.js";
import type { WikiWorkflow } from "./wiki-workflow.js";
import type { ProposalStore } from "./wiki-store.js";

type Message = { id?: string; guild_id?: string; channel_id?: string; content?: string; mentions?: Array<{ id?: string }>;
  author?: { id?: string; bot?: boolean }; webhook_id?: string };
type RequestState = { status: "processing" | "finished" | "replying" | "replied" | "error"; until?: number; outcome?: "proposal" | "no_update" };

const negativeOrQuestion = /[?？]|어떻게|방법|할\s*수|가능|하지\s*마|하지\s*말/;
const updateRequest = /(?:갱신|업데이트|반영)\s*(?:해(?:\s*줘|주세요|줄래|주실래)?|하자|해라|부탁)(?=$|[\s.!])/;

/** A plain question or a quoted URL cannot trigger the proposal writer. */
export function isDirectWikiUpdate(message: Message, botUserId: string): boolean {
  if (!isSnowflake(botUserId) || !message.author?.id || message.author.bot || message.webhook_id) return false;
  if (!message.mentions?.some((user) => user.id === botUserId)) return false;
  const raw = message.content ?? "";
  const mention = new RegExp(`<@!?${botUserId}>`, "g");
  if (!mention.test(raw)) return false;
  const text = raw.replace(mention, " ").replace(/https?:\/\/\S+/gi, " ").trim();
  return /(?:위키|wiki)/i.test(text) && updateRequest.test(text) && !negativeOrQuestion.test(text);
}

export class WikiMentionHandler {
  constructor(readonly wiki: WikiWorkflow, readonly store: ProposalStore, readonly token: string,
    readonly botUserId: () => string | null, readonly fetchImpl: typeof fetch = fetch, readonly now = Date.now,
    readonly log: (message: string) => void = console.log) {}

  private key(message: Message) { return `mention:${message.guild_id}:${message.channel_id}:${message.id}`; }
  private save(key: string, state: RequestState) { this.store.saveState(key, state); }
  private reserve(key: string): RequestState | null {
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.store.state<RequestState>(key), now = this.now();
      if (state?.status === "replied" || ((state?.status === "processing" || state?.status === "replying") && (state.until ?? 0) > now)
        || (state?.status === "error" && (state.until ?? 0) > now)) { db.exec("COMMIT"); return null; }
      if ((state?.status === "finished" || state?.status === "replying") && state.outcome) {
        this.save(key, { status: "replying", outcome: state.outcome, until: now + 10 * 60_000 });
        db.exec("COMMIT"); return { status: "replying", outcome: state.outcome };
      }
      this.save(key, { status: "processing", until: now + 10 * 60_000 });
      db.exec("COMMIT"); return { status: "processing" };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private claimReply(key: string, outcome: "proposal" | "no_update") {
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.store.state<RequestState>(key);
      if (state?.status !== "finished" || state.outcome !== outcome) { db.exec("COMMIT"); return false; }
      this.save(key, { status: "replying", outcome, until: this.now() + 10 * 60_000 });
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private async reply(message: Message, content: string, kind: "proposal" | "no_update" | "error") {
    const nonce = createHash("sha256").update(`wiki-mention:${message.id}:${kind}`).digest("hex").slice(0, 24);
    await sendDiscordMessage({ token: this.token, channelId: message.channel_id!, payload: {
      content, message_reference: { type: 0, message_id: message.id, channel_id: message.channel_id, guild_id: message.guild_id,
        fail_if_not_exists: false }, allowed_mentions: { parse: [], replied_user: false }, nonce, enforce_nonce: true
    }, fetchImpl: this.fetchImpl });
  }

  async handle(message: Message): Promise<boolean> {
    const botId = this.botUserId();
    if (!botId || !this.wiki.config.enabled || message.guild_id !== this.wiki.config.guildId || !isSnowflake(message.id ?? "")
      || !isSnowflake(message.channel_id ?? "") || !isDirectWikiUpdate(message, botId)) return false;
    // Only claim requests in the configured public wiki channels. Hermes handles all other mentions.
    try { await this.wiki.sources.channel(message.channel_id!); } catch { return false; }
    this.log("Discord Gateway 위키 갱신 멘션 수신");
    const key = this.key(message);
    const reserved = this.reserve(key);
    if (!reserved) return true;
    let outcome = reserved.outcome;
    if (reserved.status === "processing") {
      try {
        const snapshot = await this.wiki.sources.capture(message.channel_id!, { from: message.id, to: message.id, count: 1 });
        if (snapshot.messages.length !== 1 || snapshot.messages[0].id !== message.id || !snapshot.participants.includes(message.author!.id!))
          throw new Error("요청 메시지를 대화 근거로 확인하지 못했어요.");
        const row = this.store.db.prepare("SELECT status FROM snapshots WHERE hash=?").get(snapshot.source_hash) as { status: string } | undefined;
        const proposal = row?.status === "no_update" ? null : await this.wiki.propose(snapshot);
        outcome = proposal ? "proposal" : "no_update";
        this.save(key, { status: "finished", outcome });
        this.log(`Discord Gateway 위키 갱신 멘션 결과: ${outcome}`);
      } catch {
        this.save(key, { status: "error", until: this.now() + 60_000 });
        this.log("Discord Gateway 위키 갱신 멘션 생성 실패");
        try { await this.reply(message, "위키 변경안을 만들지 못했어요. 잠시 후 다시 요청해 주세요.", "error"); } catch { /* Discord delivery can be retried on another request. */ }
        return true;
      }
      if (!this.claimReply(key, outcome!)) return true;
    }
    try {
      await this.reply(message, outcome === "proposal"
        ? "이 요청으로 위키 변경안을 같은 채널에 올렸어요. 대화 참여자가 내용을 확인하고 승인하면 Draft PR을 만듭니다."
        : "이 요청에서 위키에 새로 반영할 내용을 찾지 못했어요. 사실이나 결론을 더 적은 뒤 다시 요청해 주세요.", outcome!);
      this.save(key, { status: "replied", outcome });
    } catch { this.save(key, { status: "finished", outcome }); this.log("Discord Gateway 위키 갱신 멘션 안내 실패"); }
    return true;
  }
}
