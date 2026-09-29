import { discordApiRequest, isSnowflake } from "./discord.js";
import type { WikiConfig } from "./wiki-config.js";
import { digest, StaleProposalError, type Snapshot, type SourceMessage } from "./wiki-types.js";

const PUBLIC_TYPES = new Set([0, 5, 10, 11]);
export function sourceMessage(message: any, guildId: string, channelId: string): SourceMessage {
  return { id: message.id, author_id: message.author?.id || "", bot: Boolean(message.author?.bot), webhook: Boolean(message.webhook_id),
    content: message.content || "", timestamp: message.timestamp, edited_timestamp: message.edited_timestamp || null,
    reply_to: message.message_reference?.message_id || null,
    attachments: (message.attachments || []).map((item: any) => ({ id: item.id, filename: item.filename || "", size: item.size || 0, url: item.url || "", content_type: item.content_type || null })),
    link: `https://discord.com/channels/${guildId}/${channelId}/${message.id}` };
}
export function makeSnapshot(guildId: string, channel: any, messages: any[], maxChars = 24_000): Snapshot {
  const normalized = messages.map((message) => sourceMessage(message, guildId, channel.id)).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  if (!normalized.length) throw new Error("선택한 범위에 메시지가 없어요.");
  if (JSON.stringify(normalized).length > maxChars) throw new Error("대화가 길어요. 메시지 범위를 줄여 다시 제안해 주세요.");
  const participants = [...new Set(normalized.filter((message) => !message.bot && !message.webhook && message.author_id).map((message) => message.author_id))];
  if (!participants.length) throw new Error("선택한 범위에 승인할 사람의 메시지가 없어요.");
  return { guild_id: guildId, channel_id: channel.id, channel_name: channel.name, messages: normalized, participants,
    from_id: normalized[0].id, through_id: normalized.at(-1)!.id,
    // Discord refreshes CDN query signatures without editing the attachment itself.
    source_hash: digest(normalized.map((message) => ({ ...message, attachments: message.attachments.map((attachment) => ({ ...attachment, url: attachment.url.split("?", 1)[0] })) }))), captured_at: new Date().toISOString(),
    omissions: normalized.some((message) => message.attachments.length) ? ["첨부파일 본문은 읽지 않았어요. 첨부가 필요한 결론은 검증되지 않았어요."] : [] };
}
export class DiscordSources {
  botUserId: string | null = null;
  constructor(readonly token: string, readonly config: WikiConfig, readonly fetchImpl = fetch) {}
  request(path: string) { return discordApiRequest({ token: this.token, path, fetchImpl: this.fetchImpl }); }
  async channel(channelId: string) {
    const channel: any = await this.request(`/channels/${channelId}`);
    if (channel.guild_id !== this.config.guildId || !PUBLIC_TYPES.has(channel.type)) throw new Error("허용된 서버의 일반 채널 또는 공개 스레드에서 실행해 주세요.");
    const parent: any = [10, 11].includes(channel.type) ? await this.request(`/channels/${channel.parent_id}`) : channel;
    if (!this.config.channelIds.has(parent.id) && !this.config.forumIds.has(parent.id) && !this.config.categoryIds.has(parent.parent_id)) throw new Error("위키 논의 대상 채널에서 실행해 주세요.");
    return channel;
  }
  async capture(channelId: string, { from, to, count = 100 }: { from?: string; to?: string; count?: number } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > this.config.snapshotMessages) throw new Error("메시지 개수를 허용 범위 안에서 지정해 주세요.");
    if ((from && !isSnowflake(from)) || (to && !isSnowflake(to)) || (from && to && BigInt(from) > BigInt(to))) throw new Error("시작·끝 메시지 ID를 확인해 주세요.");
    const channel = await this.channel(channelId);
    const top: any[] = to ? [await this.request(`/channels/${channelId}/messages/${to}`)] : await this.request(`/channels/${channelId}/messages?limit=1`) as any[];
    if (!top.length) throw new Error("요약할 메시지가 없어요.");
    const messages = [...top]; let before = top[0].id;
    while (messages.length < (from ? this.config.snapshotMessages + 1 : count) && (!from || BigInt(before) > BigInt(from))) {
      const limit = Math.min(100, (from ? this.config.snapshotMessages + 1 : count) - messages.length);
      const page = await this.request(`/channels/${channelId}/messages?before=${before}&limit=${limit}`) as any[];
      if (!page.length) break; messages.push(...page); before = page.at(-1).id;
      if (page.length < limit) break;
    }
    const selected = messages.filter((message) => !from || BigInt(message.id) >= BigInt(from));
    if (from && (selected.length > this.config.snapshotMessages || !messages.some((message) => message.id === from))) throw new Error("지정 범위가 너무 길거나 시작 메시지를 찾지 못했어요. 범위를 줄여 주세요.");
    const filtered = selected.filter((message) => message.author?.id !== this.botUserId);
    const snapshot = makeSnapshot(this.config.guildId, channel, filtered, this.config.snapshotChars);
    if (filtered.length !== selected.length) snapshot.omissions.push("이 봇이 게시한 요약·제안 메시지는 대화 근거에서 제외했어요.");
    return snapshot;
  }
  async verify(snapshot: Snapshot) {
    await this.channel(snapshot.channel_id);
    try {
      const current = await this.capture(snapshot.channel_id, { from: snapshot.from_id, to: snapshot.through_id, count: snapshot.messages.length });
      if (current.source_hash !== snapshot.source_hash) throw new StaleProposalError("대화가 수정되었어요. 새 범위로 제안을 다시 만들어 주세요.");
    } catch (error) { if (error instanceof StaleProposalError) throw error;
      if (error instanceof Error && /(?:404|403)$/.test(error.message)) throw new StaleProposalError("원본 메시지가 변경·삭제되었거나 접근할 수 없어요. 다시 제안해 주세요.");
      throw error;
    }
  }
  participant(snapshot: Snapshot, interaction: any) {
    const actor = interaction.member?.user || interaction.user;
    if (interaction.guild_id !== snapshot.guild_id || interaction.channel_id !== snapshot.channel_id || !actor?.id || actor.bot || !snapshot.participants.includes(actor.id)) throw new Error("이 범위의 대화에 참여한 팀원만 처리할 수 있어요.");
    return actor.id as string;
  }
  async authorize(snapshot: Snapshot, interaction: any) {
    const actorId = this.participant(snapshot, interaction);
    const member: any = await this.request(`/guilds/${snapshot.guild_id}/members/${actorId}`);
    if (member.user?.id !== actorId || member.user.bot) throw new Error("현재 서버에 참여한 팀원만 승인할 수 있어요.");
    return actorId;
  }
}
