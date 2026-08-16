const API = "https://discord.com/api/v10";

export function isSnowflake(value: string) {
  return /^\d{17,20}$/.test(value.trim());
}

export function messagePayload(notification: { title: string; url: string; body: string | null; recipients: string[] }, mappings: Map<string, string>) {
  const userIds = notification.recipients.filter((recipient) => !recipient.startsWith("role:")).map((recipient) => mappings.get(recipient)).filter((value): value is string => Boolean(value));
  const roleIds = notification.recipients.filter((recipient) => recipient.startsWith("role:")).map((recipient) => recipient.slice(5));
  const mentions = [...userIds.map((id) => `<@${id}>`), ...roleIds.map((id) => `<@&${id}>`)];
  return {
    content: mentions.join(" ") || undefined,
    embeds: [{ title: notification.title, url: notification.url, ...(notification.body ? { description: notification.body } : {}) }],
    allowed_mentions: { parse: [], users: userIds, roles: roleIds }
  };
}

export async function sendDiscordMessage({ token, channelId, payload, fetchImpl = fetch }: { token: string; channelId: string; payload: unknown; fetchImpl?: typeof fetch }) {
  const response = await fetchImpl(`${API}/channels/${channelId}/messages`, { method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Discord 메시지 전송 실패: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function discordApiRequest({ token, path, method = "GET", body, fetchImpl = fetch }: { token: string; path: string; method?: string; body?: unknown; fetchImpl?: typeof fetch }) {
  const response = await fetchImpl(`${API}${path}`, { method, headers: { Authorization: `Bot ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Discord API 요청에 실패했어요: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function sendInteractionCallback({ interactionId, interactionToken, payload, fetchImpl = fetch }: { interactionId: string; interactionToken: string; payload: unknown; fetchImpl?: typeof fetch }) {
  const response = await fetchImpl(`${API}/interactions/${interactionId}/${interactionToken}/callback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Discord 명령 응답에 실패했어요: ${response.status}`);
}

export async function editInteractionResponse({ applicationId, interactionToken, content, fetchImpl = fetch }: { applicationId: string; interactionToken: string; content: string; fetchImpl?: typeof fetch }) {
  const response = await fetchImpl(`${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  if (!response.ok) throw new Error(`Discord 명령 결과 수정에 실패했어요: ${response.status}`);
  return response.json();
}
