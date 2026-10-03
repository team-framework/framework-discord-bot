import { loadConfig } from "./config.js";
import { discoverDiscordContext, handleThreadSummaryInteraction, registerThreadSummaryCommand } from "./thread-summary.js";
import { loadWikiConfig } from "./wiki-config.js";
import { ProposalStore } from "./wiki-store.js";
import { WikiWorkflow } from "./wiki-workflow.js";
import { WikiScheduler } from "./wiki-scheduler.js";
import { WikiMentionHandler } from "./wiki-mention.js";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GUILDS_INTENT = 1 << 0;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GUILD_MESSAGES_INTENT = 1 << 9;
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function identifyPayload(token: string) { return { op: 2, d: { token, intents: GUILDS_INTENT | GUILD_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT, properties: { os: "linux", browser: "framework-discord-bot", device: "framework-discord-bot" }, presence: { since: null, activities: [], status: "online", afk: false } } }; }
export function resumePayload({ token, sessionId, sequence }: { token: string; sessionId: string; sequence: number }) { return { op: 6, d: { token, session_id: sessionId, seq: sequence } }; }

export function keepDiscordOnline({ token, WebSocketImpl = WebSocket, onReady = async (_user: any) => {}, onResume = async () => {}, onInteraction = async (_interaction: any) => {}, onMessage = async (_message: any) => {}, onError = console.error, onFatal = (_code: number) => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, random = Math.random }: any) {
  let socket: any; let sequence: number | null = null; let sessionId: string | null = null; let resumeUrl: string | null = null; let heartbeatTimer: any; let startTimer: any; let reconnectTimer: any; let awaitingAck = false; let stopped = false;
  const canResume = () => Boolean(sessionId && resumeUrl && sequence !== null);
  const clearTimers = () => { clearIntervalImpl(heartbeatTimer); clearTimeoutImpl(startTimer); clearTimeoutImpl(reconnectTimer); };
  const send = (payload: unknown) => { if (socket?.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify(payload)); };
  const heartbeat = () => { if (awaitingAck) return socket?.close(4000, "Heartbeat ACK timeout"); awaitingAck = true; send({ op: 1, d: sequence }); };
  const connect = () => {
    awaitingAck = false; socket = new WebSocketImpl(canResume() ? resumeUrl : GATEWAY_URL);
    socket.addEventListener("message", ({ data }: any) => { const payload = JSON.parse(data); if (payload.s != null) sequence = payload.s;
      if (payload.op === 10) { startTimer = setTimeoutImpl(() => { heartbeat(); heartbeatTimer = setIntervalImpl(heartbeat, payload.d.heartbeat_interval); }, Math.floor(payload.d.heartbeat_interval * random())); send(canResume() ? resumePayload({ token, sessionId: sessionId!, sequence: sequence! }) : identifyPayload(token)); }
      else if (payload.op === 11) awaitingAck = false;
      else if (payload.op === 1) heartbeat();
      else if (payload.op === 7 || payload.op === 9) { if (payload.op === 9 && !payload.d) { sessionId = null; resumeUrl = null; sequence = null; } socket.close(4000, "Discord reconnect"); }
      else if (payload.op === 0 && payload.t === "READY") { sessionId = payload.d.session_id; resumeUrl = payload.d.resume_gateway_url; Promise.resolve(onReady(payload.d.user)).catch(onError); }
      else if (payload.op === 0 && payload.t === "RESUMED") Promise.resolve(onResume()).catch(onError);
      else if (payload.op === 0 && payload.t === "INTERACTION_CREATE") Promise.resolve(onInteraction(payload.d)).catch(onError);
      else if (payload.op === 0 && payload.t === "MESSAGE_CREATE") Promise.resolve(onMessage(payload.d)).catch(onError);
    });
    socket.addEventListener("close", ({ code = 1006 }: any) => { clearIntervalImpl(heartbeatTimer); clearTimeoutImpl(startTimer); if (stopped) return; if (FATAL_CLOSE_CODES.has(code)) { stopped = true; return onFatal(code); } reconnectTimer = setTimeoutImpl(connect, canResume() ? 5_000 : 60_000); });
  };
  connect(); return () => { stopped = true; clearTimers(); socket?.close(1000, "Framework Bot 종료"); };
}

export async function runWikiJobs(scan: () => Promise<unknown>, publish: () => Promise<unknown>, log: (message: string) => void = console.error) {
  try { await scan(); } catch { log("위키 수집을 다음 주기에 다시 확인해요."); }
  try { await publish(); } catch { log("승인된 위키 작업을 다음 주기에 다시 확인해요."); }
}

if (process.argv[1]?.endsWith("gateway.js") || process.argv[1]?.endsWith("gateway.ts")) {
  const config = loadConfig(); let botUserId: string | null = null;
  const wikiConfig = loadWikiConfig();
  const store = wikiConfig.enabled ? new ProposalStore(wikiConfig.statePath) : null;
  const wiki = store ? new WikiWorkflow(wikiConfig, config.discordToken, store) : null;
  const mention = wiki && store ? new WikiMentionHandler(wiki, store, config.discordToken, () => botUserId) : null;
  const scheduler = wiki && store ? new WikiScheduler(wikiConfig, wiki.sources, store) : null;
  let timer: NodeJS.Timeout | undefined; let receivedCommands = 0;
  const stop = keepDiscordOnline({ token: config.discordToken, onReady: async (user: any) => {
    botUserId = user.id;
    const context = await discoverDiscordContext({ token: config.discordToken, teamChannelId: config.teamChannelId });
    await registerThreadSummaryCommand({ token: config.discordToken, ...context });
    if (wiki) { wiki.sources.botUserId = user.id; await wiki.register(context.applicationId);
      const run = () => runWikiJobs(() => scheduler!.tick(), () => wiki.work());
      if (!timer) timer = setInterval(() => { void run(); }, 60_000);
      void run();
    }
    console.log(`Discord Gateway READY: ${user.username}, wiki_proposals=${Boolean(wiki)}`);
  }, onResume: () => { console.log("Discord Gateway RESUMED");
  }, onInteraction: async (interaction: any) => {
    const knownCommand = interaction.type === 2 && ["위키-제안", "스레드-정리"].includes(interaction.data?.name);
    if (knownCommand) console.log(`Discord Gateway 명령 수신 ${++receivedCommands}: ${interaction.data.name}`);
    if (wiki && await wiki.handle(interaction)) { if (knownCommand) console.log("Discord Gateway 명령 처리: 위키-제안"); return; }
    await handleThreadSummaryInteraction({ interaction, token: config.discordToken, openAIKey: config.openAIKey, provider: config.summaryProvider, hermesUrl: config.hermesSummaryUrl, hermesKey: config.hermesSummaryKey, model: config.openAIModel, botUserId, wikiServiceUrl: config.wikiServiceUrl, wikiServiceKey: config.wikiServiceKey });
  }, onMessage: (message: any) => mention?.handle(message),
    onError: (error: Error) => console.error(`Discord Gateway 처리에 실패했어요: ${error.message}`), onFatal: (code: number) => console.error(`Discord Gateway가 종료됐어요. close code: ${code}.`) });
  process.once("SIGINT", () => clearInterval(timer)); process.once("SIGTERM", () => clearInterval(timer));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
