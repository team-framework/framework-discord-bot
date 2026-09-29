import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWikiConfig } from "../src/wiki-config.js";
import { WikiGitHub } from "../src/wiki-github.js";
import { WikiProposer } from "../src/wiki-proposer.js";
import { DiscordSources, makeSnapshot } from "../src/wiki-snapshot.js";
import { ProposalStore } from "../src/wiki-store.js";
import { timeSnowflake, WikiScheduler } from "../src/wiki-scheduler.js";
import { digest, proposalHash, StaleProposalError, type Proposal } from "../src/wiki-types.js";
import { WikiWorkflow } from "../src/wiki-workflow.js";

const guild = "123456789012345678"; const channel = "123456789012345679"; const category = "123456789012345680";
const human = "123456789012345681"; const other = "123456789012345682";
const config = () => loadWikiConfig({ WIKI_PROPOSALS_ENABLED: "true", WIKI_DISCORD_GUILD_ID: guild, WIKI_DISCORD_CATEGORY_IDS: category,
  WIKI_SERVICE_KEY: "read-only-test", HERMES_WIKI_KEY: "hermes-test", WIKI_TRACKING_ISSUE: "73", WIKI_GITHUB_TOKEN: "test" });
const channelData = { id: channel, type: 0, guild_id: guild, parent_id: category, name: "기술 논의" };
function message(index: number, author = human, overrides: any = {}) {
  return { id: String(123456789012346000n + BigInt(index)), author: { id: author, bot: false }, content: `결정 ${index}: 승인 후 반영한다.`, timestamp: "2026-09-29T00:00:00.000Z", attachments: [], ...overrides };
}
function fixture(): Proposal {
  const snapshot = makeSnapshot(guild, channelData, [message(1), message(2)]);
  const before = "# 원문\n\n## 승인\n이전 결정이다.\n"; const after = before.replace("이전", "새로운");
  const proposal: Proposal = { id: "abcdef1234567890abcd", version: 1, hash: "", status: "pending", snapshot, conclusion: "승인 후 위키 PR로 반영한다.", uncertainties: [],
    changes: [{ path: "결정.md", before_blob: "blob-before", before_hash: digest(before), before_content: before, after_content: after, after_hash: digest(after), diff: "-이전\n+새로운" }],
    base_commit: "base", created_at: new Date().toISOString(), notice_id: "notice" };
  proposal.hash = proposalHash(proposal); return proposal;
}

test("source snapshots retain identity, edits, replies and unread attachments; webhook and bot authors cannot approve", () => {
  const source = makeSnapshot(guild, channelData, [message(3, other, { author: { id: other, bot: true } }), message(2, other, { webhook_id: "hook" }),
    message(1, human, { edited_timestamp: "2026-09-29T01:00:00Z", message_reference: { message_id: "ref" }, attachments: [{ id: "a", filename: "data.png", size: 100, url: "https://cdn.discordapp.com/a?hm=old" }] })]);
  assert.deepEqual(source.participants, [human]); assert.equal(source.messages[0].reply_to, "ref");
  assert.equal(source.messages[0].edited_timestamp, "2026-09-29T01:00:00Z"); assert.ok(source.omissions[0].includes("읽지 않았"));
  const refreshed = makeSnapshot(guild, channelData, [message(1, human, { attachments: [{ id: "a", filename: "data.png", size: 100, url: "https://cdn.discordapp.com/a?hm=next" }] })]);
  const original = makeSnapshot(guild, channelData, [message(1, human, { attachments: [{ id: "a", filename: "data.png", size: 100, url: "https://cdn.discordapp.com/a?hm=old" }] })]);
  assert.equal(original.source_hash, refreshed.source_hash);
});

test("participant approval requires exact guild/channel and current membership", async () => {
  const source = fixture().snapshot;
  const api = new DiscordSources("test", config(), async () => Response.json({ user: { id: human, bot: false } }));
  const interaction = { guild_id: guild, channel_id: channel, member: { user: { id: human } } };
  assert.equal(await api.authorize(source, interaction), human);
  await assert.rejects(api.authorize(source, { ...interaction, member: { user: { id: other } } }), /참여한 팀원/);
  await assert.rejects(api.authorize(source, { ...interaction, channel_id: "different" }), /참여한 팀원/);
  const removed = new DiscordSources("test", config(), async () => Response.json({}, { status: 404 }));
  await assert.rejects(removed.authorize(source, interaction));
});

test("manual capture fixes the upper bound, rejects oversized ranges, private threads and source edits", async () => {
  const all = [message(1), message(2), message(3)]; let edit = false;
  const api = new DiscordSources("test", config(), async (url) => {
    const endpoint = String(url);
    if (endpoint.endsWith(`/channels/${channel}`)) return Response.json(channelData);
    if (endpoint.includes("?limit=1")) return Response.json([all[2]]);
    if (endpoint.endsWith(`/messages/${all[0].id}`)) return Response.json(all[0]);
    if (endpoint.endsWith(`/messages/${all[2].id}`)) return Response.json(all[2]);
    if (endpoint.includes("?before=")) return Response.json([...all.slice(0, 2)].reverse().map((item) => edit && item.id === all[1].id ? { ...item, edited_timestamp: "changed" } : item));
    throw new Error("unexpected endpoint");
  });
  const snapshot = await api.capture(channel, { count: 3 }); assert.equal(snapshot.messages.length, 3);
  assert.equal(snapshot.from_id, all[0].id); assert.equal(snapshot.through_id, all[2].id);
  await api.verify(snapshot); edit = true; await assert.rejects(api.verify(snapshot), StaleProposalError);
  const privateApi = new DiscordSources("test", config(), async () => Response.json({ ...channelData, type: 12 }));
  await assert.rejects(privateApi.channel(channel), /공개 스레드/);
  assert.throws(() => makeSnapshot(guild, channelData, [message(1, human, { content: "길다".repeat(20_000) })]), /대화가 길어요/);
});

test("a deleted source boundary becomes stale while transient source failures remain retryable", async () => {
  const snapshot = fixture().snapshot;
  const deleted = new DiscordSources("test", config(), async () => Response.json({}, { status: 404 }));
  await assert.rejects(deleted.verify(snapshot), StaleProposalError);
  const unavailable = new DiscordSources("test", config(), async () => Response.json({}, { status: 503 }));
  await assert.rejects(unavailable.verify(snapshot), (error: unknown) => error instanceof Error && !(error instanceof StaleProposalError) && error.message.endsWith("503"));
});

test("SQLite approval and outbox are atomic, reject duplicate clicks and recover after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "framework-proposals-")); const filename = path.join(root, "state.sqlite");
  try {
    let store = new ProposalStore(filename); const proposal = fixture(); store.put(proposal);
    assert.throws(() => store.approve(proposal.id, "wrong", human), /바뀌었/);
    store.approve(proposal.id, proposal.hash, human);
    assert.throws(() => store.approve(proposal.id, proposal.hash, human), /이미 처리/);
    store.close(); store = new ProposalStore(filename);
    assert.equal(store.get(proposal.id)?.approved_by, human); assert.equal(store.claim()?.id, proposal.id); assert.equal(store.claim(), null);
    store.retry(proposal.id, 0); const retry = store.claim()!; retry.status = "published"; store.finish(retry); assert.equal(store.claim(), null); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("approved hashes bind source, exact final bytes and human conclusions", () => {
  const proposal = fixture(); const approved = proposal.hash;
  assert.notEqual(proposalHash({ ...proposal, conclusion: "다른 결론" }), approved);
  assert.notEqual(proposalHash({ ...proposal, snapshot: { ...proposal.snapshot, source_hash: "edited" } }), approved);
  assert.notEqual(proposalHash({ ...proposal, changes: [{ ...proposal.changes[0], after_hash: "other" }] }), approved);
  assert.notEqual(proposalHash({ ...proposal, changes: [{ ...proposal.changes[0], after_content: "tampered", diff: "tampered" }] }), approved);
});

test("GitHub publication is a deterministic Draft PR and recovers an uncertain successful POST", async () => {
  const proposal = fixture(); let created: any = null; let branch: any = null; let posts = 0;
  const github = new WikiGitHub(config(), async (url, init) => {
    const endpoint = new URL(String(url)); const route = endpoint.pathname; const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (route.endsWith("/pulls") && init?.method === "POST") { posts++; assert.equal(body.draft, true); assert.match(body.head, /\/#73$/); assert.ok(!body.body.includes("Closes")); created = { html_url: "https://github.com/team-framework/framework-llm-wiki/pull/99", body: body.body, head: { sha: "branch-commit" } }; throw new Error("connection lost after delivery"); }
    if (route.endsWith("/pulls")) return Response.json(created ? [created] : []);
    if (route.endsWith("/framework-llm-wiki")) return Response.json({ default_branch: "main" });
    if (route.includes("/git/ref/heads/main")) return Response.json({ object: { sha: "base" } });
    if (route.includes("/git/ref/heads/feat")) return branch ? Response.json(branch) : Response.json({}, { status: 404 });
    if (route.includes("/contents/")) { const isAfter = endpoint.searchParams.get("ref") === "branch-commit"; return Response.json({ type: "file", encoding: "base64", sha: isAfter ? "blob-after" : "blob-before", content: Buffer.from(isAfter ? proposal.changes[0].after_content : proposal.changes[0].before_content).toString("base64") }); }
    if (route.endsWith("/git/commits/base")) return Response.json({ tree: { sha: "base-tree" } });
    if (route.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
    if (route.endsWith("/git/commits")) return Response.json({ sha: "branch-commit" });
    if (route.endsWith("/git/refs")) { branch = { object: { sha: "branch-commit" } }; return Response.json(branch); }
    throw new Error(`unexpected ${route}`);
  });
  await assert.rejects(github.publish(proposal), /connection lost/);
  assert.equal(await github.publish(proposal), created.html_url); assert.equal(posts, 1);
});

test("stale GitHub blob blocks publication before any branch mutation", async () => {
  const github = new WikiGitHub(config(), async (url, init) => {
    assert.notEqual(init?.method, "POST"); const endpoint = String(url);
    if (endpoint.includes("/pulls?")) return Response.json([]);
    if (endpoint.includes("/git/ref/")) return Response.json({ object: { sha: "new-head" } });
    if (endpoint.includes("/contents/")) return Response.json({ type: "file", encoding: "base64", sha: "changed", content: Buffer.from("changed").toString("base64") });
    return Response.json({ default_branch: "main" });
  });
  await assert.rejects(github.publish(fixture()), StaleProposalError);
});

test("proposal generation uses bounded source evidence and precise replacements, preserving surrounding text", async () => {
  const original = "# 원문\n\n## 승인\n이전 결정이다.\n\n## 다음\n유지한다.\n";
  const oldText = "## 승인\n이전 결정이다.\n";
  const github = { head: async () => ({ sha: "base", branch: "main" }), file: async () => ({ sha: "blob", content: original }) } as any;
  const proposer = new WikiProposer(config(), github, async (url, init) => {
    if (String(url).includes("/api/context")) return Response.json({ evidence: [{ path: "결정.md", content: oldText }] });
    if (String(url).includes("/api/note")) return Response.json({ note_hash: digest(original) });
    const body = JSON.parse(String(init?.body)); assert.equal(body.reasoning, "low"); assert.ok(body.instructions.includes("데이터"));
    return Response.json({ answer: JSON.stringify({ conclusion: "새 결정이다.", uncertainties: [], changes: [{ path: "결정.md", operation: "replace", old_text: oldText, new_text: "## 승인\n새 결정이다.\n" }] }) });
  });
  const proposal = await proposer.generate(fixture().snapshot); assert.ok(proposal);
  assert.ok(proposal.changes[0].after_content.startsWith("# 원문\n\n")); assert.ok(proposal.changes[0].after_content.endsWith("## 다음\n유지한다.\n"));
  assert.ok(proposal.changes[0].after_content.includes("chat-derived")); assert.equal(proposal.hash, proposalHash(proposal));
});

test("daily snapshots keep a separate backlog cursor and pending snapshots survive partial caps", async () => {
  const cfg = { ...config(), scheduleEnabled: true, dailyMessages: 2, snapshotMessages: 2 };
  const store = new ProposalStore(":memory:"); const now = Date.parse("2026-09-29T00:01:00+09:00");
  const lower = BigInt(timeSnowflake(Date.parse("2026-09-28T01:00:00+09:00")));
  const messages = [1, 2, 3].map((value) => ({ ...message(value), id: String(lower + BigInt(value)) }));
  const sources = new DiscordSources("test", cfg, async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("/guilds/") && endpoint.endsWith("/channels")) return Response.json([channelData]);
    if (endpoint.includes("threads/active") || endpoint.includes("threads/archived")) return Response.json({ threads: [], has_more: false });
    const limit = new URL(endpoint).searchParams.get("limit");
    if (limit === "1") return Response.json([messages[2]]);
    return Response.json([messages[1], messages[0]]);
  });
  const scheduler = new WikiScheduler(cfg, sources, store); await scheduler.tick(now);
  assert.equal(store.pendingSnapshots().length, 1); assert.equal(store.pendingSnapshots()[0].messages.length, 2);
  assert.equal(store.state(`scan:${channel}`), messages[1].id); assert.equal(store.state(`backlog:${channel}`), true);
  assert.equal(store.state(`finalized:${channel}`), null);
  await scheduler.tick(now + 24 * 3_600_000); assert.equal(store.state(`scan:${channel}`), messages[2].id); assert.equal(store.pendingSnapshots().length, 2);
  store.close();
});

test("old proposal buttons cannot authorize a revised proposal", async () => {
  const store = new ProposalStore(":memory:"); const proposal = fixture(); store.put(proposal); let providerCalls = 0;
  const workflow = new WikiWorkflow(config(), "test", store, async (url) => {
    if (String(url).includes("8647")) providerCalls++;
    return Response.json({});
  });
  const revised = { ...proposal, version: 2, conclusion: "수정 결론" }; revised.hash = proposalHash(revised); store.put(revised);
  await workflow.handle({ type: 3, id: "interaction", token: "token", application_id: "app", guild_id: guild, channel_id: channel, message: { id: "notice" },
    data: { custom_id: `wiki:approve:${proposal.id}:${proposal.hash.slice(0, 16)}` }, member: { user: { id: human } } });
  assert.equal(store.get(proposal.id)?.status, "pending"); assert.equal(providerCalls, 0); store.close();
});

test("an approved durable proposal publishes the exact approved bytes without regenerating them", async () => {
  const store = new ProposalStore(":memory:"); const proposal = fixture(); store.put(proposal); store.approve(proposal.id, proposal.hash, human);
  const workflow = new WikiWorkflow(config(), "test", store, async () => { throw new Error("no provider call allowed"); });
  workflow.notice = async () => {};
  workflow.sources.verify = async () => {};
  workflow.github.findPublished = async () => null;
  workflow.github.publish = async (approved) => { assert.equal(approved.hash, proposal.hash); assert.equal(approved.changes[0].after_content, proposal.changes[0].after_content); return "https://github.com/team-framework/framework-llm-wiki/pull/99"; };
  await workflow.work(); assert.equal(store.get(proposal.id)?.status, "published"); assert.equal(store.claim(), null); store.close();
});

test("delayed notice responses preserve concurrent approval and replacement versions", async () => {
  for (const action of ["approve", "revision"]) {
    const store = new ProposalStore(":memory:"); const proposal = fixture(); store.put(proposal);
    let release!: () => void; let started!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; }); const arrived = new Promise<void>((resolve) => { started = resolve; });
    let requests = 0;
    const workflow = new WikiWorkflow(config(), "test", store, async () => { if (++requests === 1) { started(); await barrier; } return Response.json({ id: "notice" }); });
    const pending = workflow.notice(proposal); await arrived;
    if (action === "approve") store.approve(proposal.id, proposal.hash, human);
    else { const revised = { ...proposal, version: 2, conclusion: "새 결론" }; revised.hash = proposalHash(revised); store.put(revised); }
    release(); await pending;
    const current = store.get(proposal.id)!;
    if (action === "approve") { assert.equal(current.status, "approved"); assert.equal(current.approved_by, human); assert.equal(store.claim()?.id, proposal.id); }
    else { assert.equal(current.version, 2); assert.equal(current.conclusion, "새 결론"); assert.notEqual(current.hash, proposal.hash); }
    assert.equal(requests, 2); store.close();
  }
});

test("simultaneous generation of one source snapshot reserves one durable proposal", async () => {
  const store = new ProposalStore(":memory:"); const proposal = fixture(); const workflow = new WikiWorkflow(config(), "test", store);
  let release!: () => void; let started!: () => void; let generations = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; }); const arrived = new Promise<void>((resolve) => { started = resolve; });
  workflow.proposer.generate = async () => { generations++; started(); await barrier; return proposal; }; workflow.notice = async () => {};
  const first = workflow.propose(proposal.snapshot); await arrived;
  await assert.rejects(workflow.propose(proposal.snapshot), /만들고 있어요/);
  assert.equal(store.pendingSnapshots().length, 0); release(); await first;
  assert.equal((await workflow.propose(proposal.snapshot))?.id, proposal.id); assert.equal(generations, 1); assert.equal(store.list().length, 1); store.close();
});

test("daily global caps preserve the first lower bound of an unvisited channel", async () => {
  const secondChannel = "123456789012345699";
  const cfg = { ...config(), scheduleEnabled: true, dailyMessages: 1 };
  const store = new ProposalStore(":memory:"); const now = Date.parse("2026-09-29T00:01:00+09:00");
  const old = String(BigInt(timeSnowflake(Date.parse("2026-09-28T01:00:00+09:00"))) + 1n);
  const sources = new DiscordSources("test", cfg, async (url) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/channels")) return Response.json([channelData, { ...channelData, id: secondChannel }]);
    if (endpoint.includes("threads/")) return Response.json({ threads: [], has_more: false });
    if (new URL(endpoint).searchParams.get("limit") === "1") return Response.json([{ ...message(1), id: old }]);
    return Response.json([]);
  });
  const scheduler = new WikiScheduler(cfg, sources, store); await scheduler.tick(now);
  assert.equal(store.pendingSnapshots().length, 1);
  const initial = timeSnowflake(Date.parse("2026-09-28T00:00:00+09:00")); assert.equal(store.state(`scan:${secondChannel}`), initial);
  await scheduler.tick(now + 24 * 3_600_000);
  assert.equal(store.pendingSnapshots().length, 2); assert.equal(store.state(`scan:${secondChannel}`), old); store.close();
});

test("archived thread discovery resumes beyond its page cap", async () => {
  const store = new ProposalStore(":memory:"); let page = 0; const offsets: string[] = [];
  const sources = new DiscordSources("test", config(), async (url) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/channels")) return Response.json([channelData]);
    if (endpoint.includes("threads/active")) return Response.json({ threads: [] });
    offsets.push(new URL(endpoint).searchParams.get("before") || ""); page++;
    return Response.json({ threads: [{ ...channelData, id: String(223456789012345000n + BigInt(page)), type: 11, parent_id: channel, thread_metadata: { archive_timestamp: `2026-09-${String(29 - page).padStart(2, "0")}T00:00:00Z` } }], has_more: page < 11 });
  });
  const scheduler = new WikiScheduler(config(), sources, store); await scheduler.discover(); assert.equal(page, 10);
  const next = store.state<string>(`archive-before:${channel}`); assert.ok(next);
  const targets = await scheduler.discover(); assert.equal(offsets[10], next); assert.equal(page, 11); assert.equal(targets.length, 12); assert.equal(store.state(`discovery-backlog:${channel}`), false); store.close();
});

test("a matching PR marker with changed approved file bytes cannot recover as published", async () => {
  const proposal = fixture();
  const github = new WikiGitHub(config(), async (url) => String(url).includes("/pulls?")
    ? Response.json([{ body: `<!-- framework-wiki-proposal:${proposal.id}:${proposal.hash} -->`, html_url: "https://github.com/team-framework/framework-llm-wiki/pull/99", head: { sha: "tampered-head" } }])
    : Response.json({ type: "file", encoding: "base64", sha: "tampered", content: Buffer.from("modified after approval").toString("base64") }));
  await assert.rejects(github.findPublished(proposal), StaleProposalError);
});

test("an already delivered PR recovers after a source edit without publishing again", async () => {
  const store = new ProposalStore(":memory:"); const proposal = fixture(); store.put(proposal); store.approve(proposal.id, proposal.hash, human);
  const workflow = new WikiWorkflow(config(), "test", store); workflow.notice = async () => {};
  workflow.github.findPublished = async () => "https://github.com/team-framework/framework-llm-wiki/pull/99";
  workflow.sources.verify = async () => { throw new StaleProposalError("edited after actual PR delivery"); };
  workflow.github.publish = async () => { throw new Error("cannot post again"); };
  await workflow.work(); assert.equal(store.get(proposal.id)?.status, "published"); assert.equal(store.claim(), null); store.close();
});

test("a disappeared scheduled target leaves its cursor intact and other channels continue", async () => {
  const second = { ...channelData, id: "123456789012345699" }; const cfg = { ...config(), scheduleEnabled: true };
  const store = new ProposalStore(":memory:"); const now = Date.parse("2026-09-29T00:01:00+09:00");
  const old = String(BigInt(timeSnowflake(Date.parse("2026-09-28T01:00:00+09:00"))) + 1n);
  const sources = new DiscordSources("test", cfg, async (url) => {
    const endpoint = String(url); if (endpoint.endsWith("/channels")) return Response.json([channelData, second]);
    if (endpoint.includes("threads/")) return Response.json({ threads: [], has_more: false });
    if (endpoint.includes(`/channels/${channel}/messages`)) return Response.json({}, { status: 404 });
    return Response.json(new URL(endpoint).searchParams.get("limit") === "1" ? [{ ...message(1), id: old }] : []);
  });
  await new WikiScheduler(cfg, sources, store).tick(now);
  assert.equal(store.state(`scan:${channel}`), timeSnowflake(Date.parse("2026-09-28T00:00:00+09:00")));
  assert.equal((store.state<any>(`blocked:${channel}`)).status, 404); assert.equal(store.pendingSnapshots().length, 1); store.close();
});

test("an expired generator cannot save over or release the next owner's reservation", () => {
  const store = new ProposalStore(":memory:"); const proposal = fixture(); store.capture(proposal.snapshot);
  const first = store.acquireGeneration(proposal.snapshot.source_hash, 1)!;
  const later = 1 + 10 * 60_000; const second = store.acquireGeneration(proposal.snapshot.source_hash, later)!;
  assert.notEqual(first, second);
  assert.throws(() => store.completeGeneration(proposal.snapshot.source_hash, first, proposal, later), /예약이 만료/);
  store.releaseGeneration(proposal.snapshot.source_hash, first); assert.equal(store.generationActive(proposal.snapshot.source_hash, later), true);
  store.completeGeneration(proposal.snapshot.source_hash, second, proposal, later); assert.equal(store.list().length, 1); store.close();
});

test('generation usage records no-update and provider failure separately without source content', async () => {
  const store = new ProposalStore(':memory:');
  const workflow = new WikiWorkflow(config(), 'test', store);
  const snapshot = fixture().snapshot;
  const usage = {model:'gpt-6-luna',reasoning:'low',input_chars:140,evidence_chars:40,usage:{input_tokens:100,output_tokens:20,cached_tokens:10}};
  workflow.proposer.generate = async (_snapshot, _conclusion, _previous, callback) => { callback?.(usage); return null; };
  assert.equal(await workflow.propose(snapshot), null);
  workflow.proposer.generate = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(workflow.propose(snapshot));
  const rows=store.db.prepare('SELECT outcome,facts FROM generation_metrics ORDER BY rowid').all() as Array<{outcome:string;facts:string}>;
  assert.equal(rows.length,2); assert.equal(rows[0].outcome,'no_update'); assert.equal(rows[1].outcome,'error');
  assert.deepEqual(JSON.parse(rows[0].facts),usage); assert.deepEqual(JSON.parse(rows[1].facts),{});
  assert.ok(!JSON.stringify(rows).includes(snapshot.messages[0].content));store.close();
});

test('new design, planning and schedule documents use create proposals and await participant approval', async () => {
  for (const [name,body] of [
    ['디자인 가이드','# 디자인 가이드\n\n로고 여백은 심볼 높이의 절반으로 합의했다.'],
    ['제품 기획','# 제품 기획\n\n첫 화면에는 프로젝트 목록을 보여주기로 합의했다.'],
    ['발표 일정','# 발표 일정\n\n발표 리허설은 2026-10-02 18:00 KST, 담당은 디자인팀으로 합의했다.'],
  ]) {
    const cfg=config();const github=new WikiGitHub(cfg);
    github.head=async()=>({branch:'main',sha:'base'});github.file=async()=>null;
    const proposer=new WikiProposer(cfg,github,async(url,init)=>{
      if(String(url).includes('/api/context'))return Response.json({evidence:[]});
      const request=JSON.parse(String(init?.body));assert.match(request.instructions,/디자인·브랜딩/);assert.match(request.instructions,/create/);
      return Response.json({answer:JSON.stringify({conclusion:name,no_update:false,changes:[{path:`기획/${name}.md`,operation:'create',content:body,why_new:'동일 주제의 기존 문서가 없다.'}]}),model:'gpt-6-luna',usage:{input_tokens:120,output_tokens:30,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:5}}});
    });
    let usage:any;const proposal=await proposer.generate(fixture().snapshot,undefined,undefined,value=>{usage=value;});
    assert.equal(proposal?.status,'pending');assert.equal(proposal?.changes[0].before_blob,null);
    assert.ok(proposal?.changes[0].after_content.includes(body));assert.match(proposal!.changes[0].after_content,/verification: chat-derived/);
    assert.equal(usage.usage.cached_tokens,20);assert.equal(usage.usage.reasoning_tokens,5);
    assert.equal(proposal?.approved_by,undefined);
  }
});
