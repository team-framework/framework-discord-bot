import { discordApiRequest, editInteractionResponse, sendDiscordMessage, sendInteractionCallback } from "./discord.js";

export const THREAD_SUMMARY_COMMAND = "스레드-정리";
const THREAD_TYPES = new Set([10, 11, 12]);
const MESSAGE_PARENT_TYPES = new Set([0, 5]);
const PRIVATE_THREAD_TYPE = 12;
const THREAD_CREATED_MESSAGE_TYPE = 18;
const MAX_MESSAGES = 500;
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_DISCORD_CONTENT = 2_000;

function required(value: string | null | undefined, name: string) { if (!value?.trim()) throw new Error(`${name} 환경변수가 필요해요.`); return value.trim(); }

export function threadSummaryCommandDefinition() { return { name: THREAD_SUMMARY_COMMAND, description: "현재 스레드를 시간 순 타임라인으로 정리해요.", type: 1, dm_permission: false }; }

export async function discoverDiscordContext({ token, teamChannelId, fetchImpl = fetch }: { token: string; teamChannelId: string | null; fetchImpl?: typeof fetch }) {
  const application: any = await discordApiRequest({ token, path: "/oauth2/applications/@me", fetchImpl });
  if (!teamChannelId) return { applicationId: application.id, guildId: null };
  const channel: any = await discordApiRequest({ token, path: `/channels/${teamChannelId}`, fetchImpl });
  return { applicationId: application.id, guildId: channel.guild_id || null };
}

export function registerThreadSummaryCommand({ token, applicationId, guildId, fetchImpl = fetch }: { token: string; applicationId: string; guildId: string | null; fetchImpl?: typeof fetch }) {
  const path = guildId ? `/applications/${applicationId}/guilds/${guildId}/commands` : `/applications/${applicationId}/commands`;
  return discordApiRequest({ token, path, method: "POST", body: threadSummaryCommandDefinition(), fetchImpl });
}

export async function fetchThreadMessages({ token, channelId, fetchImpl = fetch, maxMessages = MAX_MESSAGES }: { token: string; channelId: string; fetchImpl?: typeof fetch; maxMessages?: number }) {
  const messages: any[] = []; let before: string | null = null;
  while (messages.length < maxMessages) {
    const query = new URLSearchParams({ limit: String(Math.min(100, maxMessages - messages.length)), ...(before ? { before } : {}) });
    const page: any[] = await discordApiRequest({ token, path: `/channels/${channelId}/messages?${query}`, fetchImpl });
    messages.push(...page);
    if (page.length < 100 || !page.at(-1)?.id) break;
    before = page.at(-1).id;
  }
  return messages.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

function participant(id: string | undefined, participants: Map<string, string>) { const key = id || "unknown"; if (!participants.has(key)) participants.set(key, `참여자 ${participants.size + 1}`); return participants.get(key)!; }

export function buildThreadTranscript({ messages, botUserId, maxChars = MAX_TRANSCRIPT_CHARS }: { messages: any[]; botUserId: string | null; maxChars?: number }) {
  const participants = new Map<string, string>();
  const lines = [...messages].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()).flatMap((message) => {
    if (message.author?.id === botUserId) return [];
    const source = message.content?.trim() ? message : message.referenced_message?.content?.trim() ? message.referenced_message : null;
    if (!source) return [];
    const author = participant(source.author?.id, participants);
    const content = source.content.trim().replace(/<@!?(\d+)>/g, (_match: string, id: string) => `@${participant(id, participants)}`);
    return [`[${new Date(source.timestamp || message.timestamp).toISOString()}] ${author}: ${content}`];
  });
  if (lines.length === 0) throw new Error("요약할 텍스트 메시지가 없어요. Message Content Intent와 채널 권한을 확인해 주세요.");
  const transcript = lines.join("\n");
  if (transcript.length <= maxChars) return transcript;
  const head = Math.floor(maxChars * 0.35);
  return `${transcript.slice(0, head)}\n[중간 메시지는 길이 제한으로 생략했어요.]\n${transcript.slice(-(maxChars - head))}`;
}

export async function summarizeThread({ apiKey, model = "gpt-5-nano", transcript, fetchImpl = fetch }: { apiKey: string | null; model?: string; transcript: string; fetchImpl?: typeof fetch }) {
  const response = await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${required(apiKey, "OPENAI_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({
    model, store: false, reasoning: /^gpt-5-nano(?:-|$)/.test(model) ? { effort: "minimal" } : undefined,
    instructions: "당신은 한국어 개발 협업 스레드를 정리하는 도우미예요. 대화에 명시된 사실만 사용하고 추측하지 마세요. 원인이 확정되지 않았다면 확정되지 않았다고 적으세요. three_line_summary의 problem, action, status는 각각 한 줄로 50자 이내로 적으세요. timeline에는 중요한 확인, 시도, 결정만 발생 시각 오름차순으로 적고 time은 한국 시간 MM-DD HH:mm 형식으로 적으세요. 결론에는 결정된 내용, 해결 여부, 남은 다음 작업을 적으세요. 사람 이름이나 계정명은 꼭 필요한 경우가 아니면 제외하세요.",
    input: `다음 Discord 스레드를 정리해 주세요.\n\n${transcript}`, max_output_tokens: 1_200,
    text: { format: { type: "json_schema", name: "thread_summary", strict: true, schema: { type: "object", properties: { three_line_summary: { type: "object", properties: { problem: { type: "string" }, action: { type: "string" }, status: { type: "string" } }, required: ["problem", "action", "status"], additionalProperties: false }, timeline: { type: "array", items: { type: "object", properties: { time: { type: "string" }, event: { type: "string" } }, required: ["time", "event"], additionalProperties: false } }, conclusion: { type: "array", items: { type: "string" } } }, required: ["three_line_summary", "timeline", "conclusion"], additionalProperties: false } } }
  }) });
  if (!response.ok) throw new Error(`AI 스레드 요약에 실패했어요: ${response.status}`);
  const result: any = await response.json(); const output = result.output?.flatMap((item: any) => item.content || []).find((content: any) => content.type === "output_text")?.text;
  if (!output) throw new Error("AI가 스레드 요약 결과를 반환하지 않았어요.");
  return JSON.parse(output);
}

export function formatThreadSummary({ summary, guildId, threadId, threadName, ownerMentionId }: any) {
  const three = summary.three_line_summary || {}; const timeline = Array.isArray(summary.timeline) && summary.timeline.length ? summary.timeline : [{ time: "", event: "확인된 내용이 없어요." }]; const conclusion = Array.isArray(summary.conclusion) && summary.conclusion.length ? summary.conclusion : ["확인된 내용이 없어요."];
  const content = [`# ${required(threadName, "threadName")} 스레드 정리`, ...(ownerMentionId ? [`스레드 작성자: <@${ownerMentionId}>`] : []), "## 3줄 요약", `### 문제 상황\n${three.problem || "확인된 내용이 없어요."}`, `### 과정\n${three.action || "확인된 내용이 없어요."}`, `### 상태 / 결론\n${three.status || "확인된 내용이 없어요."}`, "## 타임라인", ...timeline.slice(0, 8).map((item: any) => `- \`${String(item.time).trim()}\` ${String(item.event).trim()}`), "## 다음 작업", ...conclusion.slice(0, 6).map((item: string) => `- ${item.trim()}`), `-# [스레드 열기](https://discord.com/channels/${guildId}/${threadId})`].join("\n\n");
  return content.length <= MAX_DISCORD_CONTENT ? content : `${content.slice(0, MAX_DISCORD_CONTENT - 20)}\n…(일부 생략했어요.)`;
}

export async function handleThreadSummaryInteraction({ interaction, token, openAIKey, model, botUserId, fetchImpl = fetch, logger = console }: any) {
  if (interaction.type !== 2 || interaction.data?.name !== THREAD_SUMMARY_COMMAND) return false;
  await sendInteractionCallback({ interactionId: interaction.id, interactionToken: interaction.token, payload: { type: 5, data: { flags: 64 } }, fetchImpl });
  try {
    const thread: any = await discordApiRequest({ token, path: `/channels/${interaction.channel_id}`, fetchImpl });
    if (!THREAD_TYPES.has(thread.type) || !thread.parent_id) throw new Error("이 명령은 Discord 스레드 안에서만 사용할 수 있어요.");
    const parent: any = await discordApiRequest({ token, path: `/channels/${thread.parent_id}`, fetchImpl });
    if (!MESSAGE_PARENT_TYPES.has(parent.type)) throw new Error("포럼·미디어 게시물은 원본 채널에 답글을 남길 수 없어요.");
    const starter: any = thread.type === PRIVATE_THREAD_TYPE ? null : await discordApiRequest({ token, path: `/channels/${thread.parent_id}/messages/${thread.id}`, fetchImpl });
    const summary = await summarizeThread({ apiKey: openAIKey, model, transcript: buildThreadTranscript({ messages: await fetchThreadMessages({ token, channelId: thread.id, fetchImpl }), botUserId }), fetchImpl });
    const reply = starter && starter.type !== THREAD_CREATED_MESSAGE_TYPE;
    const posted: any = await sendDiscordMessage({ token, channelId: thread.parent_id, payload: { content: formatThreadSummary({ summary, guildId: thread.guild_id, threadId: thread.id, threadName: thread.name, ownerMentionId: reply ? null : thread.owner_id }), ...(reply ? { message_reference: { type: 0, message_id: starter.id, channel_id: thread.parent_id, guild_id: thread.guild_id, fail_if_not_exists: true } } : {}), allowed_mentions: reply ? { parse: [], replied_user: true } : { parse: [], users: thread.owner_id ? [thread.owner_id] : [] } }, fetchImpl });
    await editInteractionResponse({ applicationId: interaction.application_id, interactionToken: interaction.token, content: `원본 채널에 [스레드 정리](https://discord.com/channels/${thread.guild_id}/${thread.parent_id}/${posted.id})를 남겼어요.`, fetchImpl });
  } catch (error: any) { logger.error(`스레드 정리에 실패했어요: ${error.message}`); await editInteractionResponse({ applicationId: interaction.application_id, interactionToken: interaction.token, content: error.message?.startsWith("이 명령은") || error.message?.startsWith("포럼") ? error.message : "스레드를 정리하지 못했어요. 봇 권한과 AI 설정을 확인해 주세요.", fetchImpl }); }
  return true;
}
