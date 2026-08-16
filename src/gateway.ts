import { loadConfig } from "./config.js";
import { discoverDiscordContext, handleThreadSummaryInteraction, registerThreadSummaryCommand } from "./thread-summary.js";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const MESSAGE_CONTENT_INTENT = 1 << 15;
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function identifyPayload(token: string) { return { op: 2, d: { token, intents: MESSAGE_CONTENT_INTENT, properties: { os: "linux", browser: "framework-discord-bot", device: "framework-discord-bot" }, presence: { since: null, activities: [], status: "online", afk: false } } }; }
export function resumePayload({ token, sessionId, sequence }: { token: string; sessionId: string; sequence: number }) { return { op: 6, d: { token, session_id: sessionId, seq: sequence } }; }

export function keepDiscordOnline({ token, WebSocketImpl = WebSocket, onReady = async (_user: any) => {}, onInteraction = async (_interaction: any) => {}, onError = console.error, onFatal = (_code: number) => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, random = Math.random }: any) {
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
      else if (payload.op === 0 && payload.t === "INTERACTION_CREATE") Promise.resolve(onInteraction(payload.d)).catch(onError);
    });
    socket.addEventListener("close", ({ code = 1006 }: any) => { clearIntervalImpl(heartbeatTimer); clearTimeoutImpl(startTimer); if (stopped) return; if (FATAL_CLOSE_CODES.has(code)) { stopped = true; return onFatal(code); } reconnectTimer = setTimeoutImpl(connect, canResume() ? 5_000 : 60_000); });
  };
  connect(); return () => { stopped = true; clearTimers(); socket?.close(1000, "Framework Bot 종료"); };
}

if (process.argv[1]?.endsWith("gateway.js") || process.argv[1]?.endsWith("gateway.ts")) {
  const config = loadConfig(); let botUserId: string | null = null;
  const stop = keepDiscordOnline({ token: config.discordToken, onReady: async (user: any) => { botUserId = user.id; const context = await discoverDiscordContext({ token: config.discordToken, teamChannelId: config.teamChannelId }); await registerThreadSummaryCommand({ token: config.discordToken, ...context }); console.log(`Discord Gateway 연결 완료: ${user.username}`); }, onInteraction: (interaction: any) => handleThreadSummaryInteraction({ interaction, token: config.discordToken, openAIKey: config.openAIKey, model: config.openAIModel, botUserId }), onError: (error: Error) => console.error(`Discord Gateway 처리에 실패했어요: ${error.message}`), onFatal: (code: number) => console.error(`Discord Gateway가 종료됐어요. close code: ${code}.`) });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
