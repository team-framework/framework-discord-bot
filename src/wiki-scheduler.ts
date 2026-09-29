import type { WikiConfig } from "./wiki-config.js";
import { makeSnapshot, type DiscordSources } from "./wiki-snapshot.js";
import type { ProposalStore } from "./wiki-store.js";

const EPOCH = 1_420_070_400_000n;
export function timeSnowflake(time: number) { return ((BigInt(time) - EPOCH) << 22n).toString(); }
export function seoulDay(time: number) { return new Date(time + 9 * 3_600_000).toISOString().slice(0, 10); }
type ScanBuffer = { lower: string; upper: string; before: string; messages: any[]; complete: boolean };
export class WikiScheduler {
  private running = false;
  constructor(readonly config: WikiConfig, readonly sources: DiscordSources, readonly store: ProposalStore) {}
  async discover() {
    const guildChannels = await this.sources.request(`/guilds/${this.config.guildId}/channels`) as any[];
    const parents = guildChannels.filter((channel) => [0, 5, 15, 16].includes(channel.type)
      && (this.config.channelIds.has(channel.id) || this.config.forumIds.has(channel.id) || this.config.categoryIds.has(channel.parent_id)));
    const allowed = new Set(parents.map((channel) => channel.id));
    const targets = new Map<string, any>(parents.filter((channel) => [0, 5].includes(channel.type)).map((channel) => [channel.id, channel]));
    const active = await this.sources.request(`/guilds/${this.config.guildId}/threads/active`) as any;
    for (const thread of active.threads || []) if ([10, 11].includes(thread.type) && allowed.has(thread.parent_id)) targets.set(thread.id, thread);
    for (const known of this.store.state<any[]>("scheduled-targets") || []) if (allowed.has(known.parent_id)) targets.set(known.id, targets.get(known.id) || known);
    for (const parent of parents) {
      const archiveKey = `archive-before:${parent.id}`;
      let before = this.store.state<string>(archiveKey) || "";
      for (let pages = 0; pages < 10; pages++) {
        const result = await this.sources.request(`/channels/${parent.id}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`) as any;
        for (const thread of result.threads || []) if ([10, 11].includes(thread.type)) targets.set(thread.id, thread);
        this.store.saveState("scheduled-targets", [...targets.values()]);
        if (!result.has_more) { this.store.saveState(archiveKey, null); this.store.saveState(`discovery-backlog:${parent.id}`, false); break; }
        before = result.threads?.at(-1)?.thread_metadata?.archive_timestamp;
        if (!before) throw new Error("공개 스레드의 이어 읽기 정보를 확인하지 못했어요.");
        this.store.saveState(archiveKey, before);
        if (pages === 9) this.store.saveState(`discovery-backlog:${parent.id}`, true);
      }
    }
    // Previously discovered public threads remain eligible even after being archived.
    const result = [...targets.values()]; this.store.saveState("scheduled-targets", result); return result;
  }
  async tick(now = Date.now()) {
    if (!this.config.scheduleEnabled || this.running) return;
    const day = seoulDay(now);
    if (this.store.state("scheduled-day") === day) return;
    this.running = true;
    try {
      const boundary = Date.parse(`${day}T00:00:00+09:00`);
      const initialLower = this.store.state<string>("schedule-initial-lower") || timeSnowflake(boundary - 24 * 3_600_000);
      this.store.saveState("schedule-initial-lower", initialLower);
      let captured = 0; let pagesLeft = 200;
      const targets = await this.discover();
      for (const target of targets) if (!this.store.state(`scan:${target.id}`)) this.store.saveState(`scan:${target.id}`, initialLower);
      for (const target of targets) {
        if (captured >= this.config.dailyMessages || pagesLeft <= 0) break;
        try {
        const cursorKey = `scan:${target.id}`; const bufferKey = `buffer:${target.id}`;
        const cursor = this.store.state<string>(cursorKey) || timeSnowflake(boundary - 24 * 3_600_000);
        let buffer = this.store.state<ScanBuffer>(bufferKey);
        if (!buffer) {
          const top = await this.sources.request(`/channels/${target.id}/messages?before=${timeSnowflake(boundary)}&limit=1`) as any[]; pagesLeft--;
          if (!top.length || BigInt(top[0].id) <= BigInt(cursor)) continue;
          buffer = { lower: cursor, upper: top[0].id, before: top[0].id, messages: top, complete: false };
          this.store.saveState(bufferKey, buffer);
        }
        // Persist reverse page progress separately. A cap cannot skip unseen older messages.
        while (!buffer.complete && pagesLeft > 0) {
          const page = await this.sources.request(`/channels/${target.id}/messages?before=${buffer.before}&limit=100`) as any[]; pagesLeft--;
          const selected = page.filter((message) => BigInt(message.id) > BigInt(buffer!.lower));
          const ids = new Set(buffer.messages.map((message) => message.id));
          buffer.messages.push(...selected.filter((message) => !ids.has(message.id)));
          buffer.complete = page.length < 100 || page.some((message) => BigInt(message.id) <= BigInt(buffer!.lower));
          if (page.length) buffer.before = page.at(-1).id;
          this.store.saveState(bufferKey, buffer);
          // A long history is spooled across daily runs, rather than discarded or clipped.
        }
        if (!buffer.complete) { this.store.saveState(`backlog:${target.id}`, true); continue; }
        buffer.messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        const savedCursor = this.store.state<string>(cursorKey);
        if (savedCursor) buffer.messages = buffer.messages.filter((message) => BigInt(message.id) > BigInt(savedCursor));
        while (buffer.messages.length && captured < this.config.dailyMessages) {
          const chunk: any[] = [];
          for (const message of buffer.messages) {
            if (chunk.length >= this.config.snapshotMessages || captured + chunk.length >= this.config.dailyMessages) break;
            try { makeSnapshot(this.config.guildId, target, [...chunk, message], this.config.snapshotChars); chunk.push(message); }
            catch (error) {
              if (!chunk.length && (message.author?.bot || message.webhook_id)) { chunk.push(message); continue; }
              if (!chunk.length) { this.store.saveState(`oversized:${target.id}:${message.id}`, { id: message.id, reason: "단일 메시지가 범위를 초과해 수동 검토가 필요해요." }); }
              break;
            }
          }
          if (!chunk.length) { this.store.saveState(`backlog:${target.id}`, true); break; }
          const included = chunk.filter((message) => message.author?.id !== this.sources.botUserId);
          const humans = included.some((message) => !message.author?.bot && !message.webhook_id);
          if (humans) {
            const snapshot = makeSnapshot(this.config.guildId, target, included, this.config.snapshotChars);
            if (included.length !== chunk.length) snapshot.omissions.push("이 봇이 게시한 요약·제안 메시지는 대화 근거에서 제외했어요.");
            this.store.capture(snapshot, cursorKey);
          }
          else { this.store.saveState(`excluded-bots:${target.id}:${chunk.at(-1).id}`, chunk.map((message) => message.id)); this.store.saveState(cursorKey, chunk.at(-1).id); }
          captured += chunk.length; buffer.messages.splice(0, chunk.length);
          this.store.saveState(bufferKey, buffer);
        }
        if (!buffer.messages.length) { this.store.saveState(bufferKey, null); this.store.saveState(`backlog:${target.id}`, false); }
        else this.store.saveState(`backlog:${target.id}`, true);
        this.store.saveState(`blocked:${target.id}`, false);
        } catch (error) {
          if (error instanceof Error && /(?:403|404)$/.test(error.message)) this.store.saveState(`blocked:${target.id}`, { status: Number(error.message.slice(-3)), at: new Date(now).toISOString() });
          else throw error;
        }
      }
      this.store.saveState("scheduled-day", day); this.store.saveState("scheduled-last-run", { at: new Date(now).toISOString(), captured_messages: captured, remaining_page_budget: pagesLeft });
    } finally { this.running = false; }
  }
}
