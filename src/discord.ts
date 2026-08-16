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
}
