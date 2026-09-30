import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { identifyPayload, keepDiscordOnline } from "../src/gateway.js";
import { isDirectWikiUpdate, WikiMentionHandler } from "../src/wiki-mention.js";
import { loadWikiConfig } from "../src/wiki-config.js";
import { makeSnapshot } from "../src/wiki-snapshot.js";
import { ProposalStore } from "../src/wiki-store.js";
import type { WikiWorkflow } from "../src/wiki-workflow.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wiki-mention-intent.json", import.meta.url), "utf8"));
const bot = fixture.bot_id as string;
const guild = "123456789012345679", channel = "123456789012345680", author = "123456789012345681";
const requestId = "123456789012345682";
const config = loadWikiConfig({ WIKI_PROPOSALS_ENABLED: "true", WIKI_DISCORD_GUILD_ID: guild, WIKI_DISCORD_CHANNEL_IDS: channel,
  WIKI_SERVICE_KEY: "service", HERMES_WIKI_KEY: "inference" });
const channelData = { id: channel, guild_id: guild, type: 0, parent_id: null, name: "배포" };

function request(overrides: Record<string, unknown> = {}) {
  return { id: requestId, guild_id: guild, channel_id: channel,
    content: `<@${bot}> One Store 배포 완료 https://m.onestore.co.kr/v2/ko-kr/app/0001009427 이거로 위키 갱신해`,
    mentions: [{ id: bot }], author: { id: author, bot: false }, timestamp: "2026-09-30T00:00:00Z", attachments: [], ...overrides };
}

function setup(options: { noUpdate?: boolean; failOnce?: boolean; replyFailsOnce?: boolean } = {}) {
  const store = new ProposalStore(":memory:");
  const snapshot = makeSnapshot(guild, channelData, [request()]);
  let generated = 0, captured = 0, replies = 0;
  const wiki = { config, sources: {
    channel: async (id: string) => { if (id !== channel) throw new Error("unallowed"); return channelData; },
    capture: async (id: string, range: unknown) => { captured++; assert.equal(id, channel); assert.deepEqual(range, { from: requestId, to: requestId, count: 1 }); return snapshot; }
  }, propose: async (source: typeof snapshot) => {
    generated++;
    assert.equal(source.messages.length, 1); assert.deepEqual(source.participants, [author]);
    assert.equal(source.messages[0].id, requestId);
    if (options.failOnce && generated === 1) throw new Error("private provider error");
    store.capture(source); store.snapshotDone(source.source_hash, options.noUpdate ? "no_update" : "proposed");
    return options.noUpdate ? null : { id: "proposal", status: "pending" };
  } } as unknown as WikiWorkflow;
  const posts: Array<{ content: string; allowed_mentions: unknown; nonce: string; enforce_nonce: boolean }> = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    replies++;
    const payload = JSON.parse(String(init?.body)); posts.push(payload);
    if (options.replyFailsOnce && replies === 1) return Response.json({}, { status: 503 });
    return Response.json({ id: String(replies) });
  };
  let now = 1_000_000;
  const handler = new WikiMentionHandler(wiki, store, "test-token", () => bot, fetchImpl as typeof fetch, () => now, () => {});
  return { handler, store, posts, snapshot, generated: () => generated, captured: () => captured, replies: () => replies, advance: (ms: number) => { now += ms; } };
}

test("shared intent fixture accepts only direct imperative wiki requests", () => {
  for (const row of fixture.cases as Array<{ name: string; content: string; mentioned: boolean; expected: boolean }>) {
    const message = request({ content: row.content, mentions: row.mentioned ? [{ id: bot }] : [] });
    assert.equal(isDirectWikiUpdate(message, bot), row.expected, row.name);
  }
  assert.equal(isDirectWikiUpdate(request({ author: { id: author, bot: true } }), bot), false);
  assert.equal(isDirectWikiUpdate(request({ webhook_id: "hook" }), bot), false);
});

test("Gateway requests guild messages and dispatches MESSAGE_CREATE", async () => {
  assert.equal(identifyPayload("token").d.intents & (1 << 9), 1 << 9);
  assert.equal(identifyPayload("token").d.intents & 1, 1);
  class Socket {
    static OPEN = 1;
    readyState = 1;
    handlers = new Map<string, (event: any) => void>();
    constructor(_url: string) {}
    addEventListener(type: string, callback: (event: any) => void) { this.handlers.set(type, callback); }
    send(_value: string) {}
    close() {}
    emit(type: string, event: unknown) { this.handlers.get(type)?.(event); }
  }
  let socket!: Socket;
  class CapturedSocket extends Socket { constructor(url: string) { super(url); socket = this; } }
  let resolve!: (value: unknown) => void;
  const delivered = new Promise((done) => { resolve = done; });
  const stop = keepDiscordOnline({ token: "token", WebSocketImpl: CapturedSocket,
    onMessage: async (message: unknown) => resolve(message) });
  const payload = { id: requestId };
  socket.emit("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 1, d: payload }) });
  assert.deepEqual(await delivered, payload);
  stop();
});

test("one mention creates one bounded proposal and a truthful approval reply; duplicates stay silent", async () => {
  const f = setup();
  try {
    assert.equal(await f.handler.handle(request()), true);
    assert.equal(f.generated(), 1); assert.equal(f.captured(), 1); assert.equal(f.replies(), 1);
    assert.match(f.posts[0].content, /승인하면 Draft PR/);
    assert.deepEqual(f.posts[0].allowed_mentions, { parse: [], replied_user: false });
    assert.equal(f.posts[0].enforce_nonce, true); assert.equal(f.posts[0].nonce.length, 24);
    assert.equal(await f.handler.handle(request()), true);
    assert.equal(f.generated(), 1); assert.equal(f.replies(), 1);
  } finally { f.store.close(); }
});

test("simultaneous delivery while a reply is pending does not post twice", async () => {
  const f = setup({ noUpdate: true });
  let arrived!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { arrived = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  (f.handler as any).fetchImpl = async () => { arrived(); await barrier; return Response.json({ id: "posted" }); };
  try {
    const first = f.handler.handle(request());
    await started;
    assert.equal(await f.handler.handle(request()), true);
    assert.equal(f.generated(), 1);
    release(); await first;
    assert.equal(f.store.state<{ status: string }>(`mention:${guild}:${channel}:${requestId}`)?.status, "replied");
  } finally { f.store.close(); }
});

test("unconfigured guild and channel, questions, bots, and webhooks do not invoke the proposal", async () => {
  const f = setup();
  try {
    for (const item of [request({ guild_id: "123456789012345699" }), request({ channel_id: "123456789012345699" }),
      request({ content: `<@${bot}> 위키 어떻게 갱신해?` }), request({ author: { id: author, bot: true } }), request({ webhook_id: "hook" })])
      assert.equal(await f.handler.handle(item), false);
    assert.equal(f.generated(), 0); assert.equal(f.replies(), 0);
  } finally { f.store.close(); }
});

test("no-update response is truthful, failure retries after lease, and reply retry does not regenerate", async () => {
  const empty = setup({ noUpdate: true });
  try {
    await empty.handler.handle(request());
    assert.match(empty.posts[0].content, /새로 반영할 내용을 찾지 못했어요/);
    await empty.handler.handle(request()); assert.equal(empty.generated(), 1);
  } finally { empty.store.close(); }

  const failed = setup({ failOnce: true });
  try {
    await failed.handler.handle(request());
    assert.match(failed.posts[0].content, /만들지 못했어요/);
    assert.ok(!failed.posts[0].content.includes("private provider"));
    await failed.handler.handle(request()); assert.equal(failed.generated(), 1);
    failed.advance(60_001); await failed.handler.handle(request());
    assert.equal(failed.generated(), 2); assert.match(failed.posts[1].content, /승인하면 Draft PR/);
    assert.notEqual(failed.posts[0].nonce, failed.posts[1].nonce);
  } finally { failed.store.close(); }

  const replyFailure = setup({ noUpdate: true, replyFailsOnce: true });
  try {
    await replyFailure.handler.handle(request());
    await replyFailure.handler.handle(request());
    assert.equal(replyFailure.generated(), 1); assert.equal(replyFailure.replies(), 2);
  } finally { replyFailure.store.close(); }
});
