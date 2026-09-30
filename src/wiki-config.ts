import { isSnowflake } from "./discord.js";
export type WikiConfig = {
  enabled: boolean; guildId: string; categoryIds: Set<string>; channelIds: Set<string>; forumIds: Set<string>;
  serviceUrl: string; serviceKey: string; hermesUrl: string; hermesKey: string; statePath: string;
  repository: string; trackingIssue: number; appClientId: string; privateKeyPath: string; githubToken: string;
  coauthorUsers: Map<string, string>;
  coauthorExcludedDiscordIds: Set<string>;
  scheduleEnabled: boolean; snapshotMessages: number; snapshotChars: number; dailyMessages: number;
};
function parseCoauthorUsers(value: string, source: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${source}은 JSON이어야 해요.`); }
  if (!Array.isArray(parsed)) throw new Error(`${source}은 배열이어야 해요.`);
  const users = new Map<string, string>();
  for (const item of parsed) {
    const github = typeof item?.github === "string" ? item.github.trim() : "";
    const discordUserId = typeof item?.discordUserId === "string" ? item.discordUserId.trim() : "";
    if (!github || !isSnowflake(discordUserId) || (users.has(discordUserId) && users.get(discordUserId)!.toLowerCase() !== github.toLowerCase())) {
      throw new Error("위키 공동 작성자의 Discord ID마다 GitHub 계정을 하나씩 지정해 주세요.");
    }
    users.set(discordUserId, github);
  }
  return users;
}
export function loadWikiConfig(env = process.env): WikiConfig {
  const enabled = env.WIKI_PROPOSALS_ENABLED === "true";
  const ids = (name: string) => {
    const entries = (env[name] || "").split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.some((entry) => !isSnowflake(entry))) throw new Error(`${name}의 Discord ID가 올바르지 않아요.`);
    return new Set(entries);
  };
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} 값이 올바르지 않아요.`);
    return value;
  };
  const required = (name: string) => { const value = env[name]?.trim() || ""; if (enabled && !value) throw new Error(`${name} 설정이 필요해요.`); return value; };
  const guildId = required("WIKI_DISCORD_GUILD_ID");
  if (guildId && !isSnowflake(guildId)) throw new Error("WIKI_DISCORD_GUILD_ID 값이 올바르지 않아요.");
  const repository = env.WIKI_GITHUB_REPOSITORY || "team-framework/framework-llm-wiki";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("WIKI_GITHUB_REPOSITORY 값이 올바르지 않아요.");
  const excluded = (env.WIKI_COAUTHOR_EXCLUDED_DISCORD_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (excluded.some((id) => !isSnowflake(id))) throw new Error("WIKI_COAUTHOR_EXCLUDED_DISCORD_IDS의 Discord ID가 올바르지 않아요.");
  const coauthorMappingOverride = env.WIKI_COAUTHOR_MAPPINGS_JSON?.trim();
  return { enabled, guildId, categoryIds: ids("WIKI_DISCORD_CATEGORY_IDS"), channelIds: ids("WIKI_DISCORD_CHANNEL_IDS"), forumIds: ids("WIKI_DISCORD_FORUM_IDS"),
    serviceUrl: env.WIKI_SERVICE_URL || "http://127.0.0.1:3005", serviceKey: required("WIKI_SERVICE_KEY"),
    hermesUrl: env.HERMES_WIKI_URL || "http://127.0.0.1:8647/v1/wiki/answer", hermesKey: required("HERMES_WIKI_KEY"),
    statePath: env.WIKI_STATE_PATH || "runtime/wiki-proposals.sqlite", repository,
    trackingIssue: env.WIKI_TRACKING_ISSUE ? integer("WIKI_TRACKING_ISSUE", 1, 1_000_000) : 0,
    appClientId: env.WIKI_GITHUB_APP_CLIENT_ID || "", privateKeyPath: env.WIKI_GITHUB_APP_PRIVATE_KEY_PATH || "", githubToken: env.WIKI_GITHUB_TOKEN || "",
    coauthorUsers: parseCoauthorUsers(coauthorMappingOverride || env.DISCORD_USER_MAPPINGS_JSON?.trim() || "[]", coauthorMappingOverride ? "WIKI_COAUTHOR_MAPPINGS_JSON" : "DISCORD_USER_MAPPINGS_JSON"),
    coauthorExcludedDiscordIds: new Set(excluded),
    scheduleEnabled: enabled && env.WIKI_SCHEDULE_ENABLED === "true", snapshotMessages: integer("WIKI_SNAPSHOT_MESSAGES", 300, 500),
    snapshotChars: integer("WIKI_SNAPSHOT_CHARS", 24_000, 100_000), dailyMessages: integer("WIKI_DAILY_MESSAGES", 3_000, 20_000) };
}
