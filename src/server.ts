import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { messagePayload, sendDiscordMessage } from "./discord.js";
import { notificationFor } from "./events.js";

function signed(secret: string, body: Buffer, signature: string | undefined) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function loadDeliveries(path: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("delivery state format is invalid");
    return new Set(parsed);
  } catch (error: any) {
    if (error.code === "ENOENT") return new Set<string>();
    throw error;
  }
}

async function saveDeliveries(path: string, deliveries: Set<string>) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify([...deliveries].slice(-5_000)));
  await rename(temporary, path);
}

function respond(response: any, status: number, body: string) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(`${body}\n`);
}

export function startServer(config: Config, fetchImpl = fetch) {
  const deliveries = loadDeliveries(config.statePath);
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") return respond(response, 200, "ok");
    if (request.method !== "POST" || request.url !== config.webhookPath) return respond(response, 404, "not found");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const signature = request.headers["x-hub-signature-256"];
    if (!signed(config.webhookSecret, body, typeof signature === "string" ? signature : undefined)) return respond(response, 401, "invalid signature");
    const event = request.headers["x-github-event"];
    const deliveryId = request.headers["x-github-delivery"];
    if (typeof event !== "string" || typeof deliveryId !== "string") return respond(response, 400, "missing GitHub headers");
    let payload: any;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return respond(response, 400, "invalid JSON"); }
    if (!config.repositories.has(payload.repository?.full_name)) return respond(response, 403, "repository not allowed");
    const state = await deliveries;
    if (state.has(deliveryId)) return respond(response, 200, "duplicate");
    const notification = notificationFor(event, payload, config.prOpenRoleId);
    if (!notification) return respond(response, 200, "ignored");
    const discordPayload = messagePayload(notification, config.users);
    if (notification.recipients.length > 0 && !discordPayload.content) return respond(response, 200, "recipient not mapped");
    await sendDiscordMessage({ token: config.discordToken, channelId: config.channels.get(notification.repository)!, payload: discordPayload, fetchImpl });
    state.add(deliveryId);
    await saveDeliveries(config.statePath, state);
    return respond(response, 202, "accepted");
  });
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  const config = loadConfig();
  startServer(config).listen(config.webhookPort, () => console.log(`Discord Bot webhook listening on ${config.webhookPort}${config.webhookPath}`));
}
