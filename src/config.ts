import { isSnowflake } from "./discord.js";

export type DiscordUserMappings = Map<string, string>;

export type Config = {
  webhookSecret: string;
  webhookPort: number;
  webhookPath: string;
  repositories: Set<string>;
  discordToken: string;
  channels: Map<string, string>;
  users: DiscordUserMappings;
  prOpenRoleId: string | null;
  statePath: string;
};

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} 환경변수가 필요해요.`);
  return value;
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name}은 JSON이어야 해요.`);
  }
}

function parseRepositories(value: string) {
  const repositories = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (repositories.length === 0 || repositories.some((item) => !/^[^/]+\/[^/]+$/.test(item))) {
    throw new Error("GITHUB_REPOSITORIES는 쉼표로 구분한 owner/repository 목록이어야 해요.");
  }
  return new Set(repositories);
}

function parseChannels(value: string, repositories: Set<string>) {
  const parsed = parseJson(value, "DISCORD_CHANNELS_JSON");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("DISCORD_CHANNELS_JSON은 객체여야 해요.");
  const channels = new Map<string, string>();
  for (const repository of repositories) {
    const channel = (parsed as Record<string, unknown>)[repository];
    if (typeof channel !== "string" || !isSnowflake(channel)) throw new Error(`${repository}의 Discord 채널 ID가 필요해요.`);
    channels.set(repository, channel);
  }
  return channels;
}

function parseUsers(value: string) {
  const parsed = parseJson(value, "DISCORD_USER_MAPPINGS_JSON");
  if (!Array.isArray(parsed)) throw new Error("DISCORD_USER_MAPPINGS_JSON은 배열이어야 해요.");
  const users = new Map<string, string>();
  for (const item of parsed) {
    const github = typeof item?.github === "string" ? item.github.trim() : "";
    const discordUserId = typeof item?.discordUserId === "string" ? item.discordUserId.trim() : "";
    if (!github || !isSnowflake(discordUserId) || users.has(github)) throw new Error("GitHub 사용자와 Discord 사용자 ID의 일대일 매핑이 필요해요.");
    users.set(github, discordUserId);
  }
  return users;
}

function parsePort(value: string | undefined) {
  const port = Number(value || 3008);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("GITHUB_WEBHOOK_PORT는 1~65535 사이여야 해요.");
  return port;
}

export function loadConfig(env = process.env): Config {
  const repositories = parseRepositories(required(env, "GITHUB_REPOSITORIES"));
  const webhookPath = env.GITHUB_WEBHOOK_PATH?.trim() || "/github/webhooks";
  if (!webhookPath.startsWith("/") || webhookPath.includes("?")) throw new Error("GITHUB_WEBHOOK_PATH는 /로 시작하는 경로여야 해요.");
  const role = env.DISCORD_PR_OPEN_ROLE_ID?.trim() || null;
  if (role && !isSnowflake(role)) throw new Error("DISCORD_PR_OPEN_ROLE_ID는 Discord role ID여야 해요.");
  return {
    webhookSecret: required(env, "GITHUB_WEBHOOK_SECRET"),
    webhookPort: parsePort(env.GITHUB_WEBHOOK_PORT),
    webhookPath,
    repositories,
    discordToken: required(env, "DISCORD_BOT_TOKEN"),
    channels: parseChannels(required(env, "DISCORD_CHANNELS_JSON"), repositories),
    users: parseUsers(required(env, "DISCORD_USER_MAPPINGS_JSON")),
    prOpenRoleId: role,
    statePath: env.DELIVERY_STATE_PATH?.trim() || "runtime/deliveries.json"
  };
}
