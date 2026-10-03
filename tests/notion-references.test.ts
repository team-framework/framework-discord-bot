import assert from "node:assert/strict";
import test from "node:test";
import { readThreadNotionReferences, threadNotionIds } from "../src/notion-references.js";
import { formatThreadSummary, handleThreadSummaryInteraction, summarizeThread } from "../src/thread-summary.js";

const id = "30cba097c65980b5bddbfd0a67de936a";
const transcript = `확인 https://app.notion.com/p/Framework-${id}?source=copy_link`;
const page = { id, title: "Framework", url: `https://app.notion.com/p/${id}`, content: "원문 근거", content_hash: "hash", page_last_edited_at: "2026-10-01", truncated: false };
const summary = { three_line_summary: { problem: "문제", action: "확인", status: "진행" }, timeline: [], conclusion: ["재확인"] };
test("Notion links are deduplicated and arbitrary websites are never fetched", () => {
  assert.deepEqual(threadNotionIds(`${transcript} https://notion.so/${id} https://notion.so.evil.test/${id}`), [id]);
});
test("reads references only through the configured authenticated Wiki API", async () => {
  const references = await readThreadNotionReferences(transcript, { serviceUrl: "http://127.0.0.1:3100", serviceKey: "readonly-secret", fetchImpl: async (value, init) => {
    const url = new URL(String(value)); assert.equal(url.origin, "http://127.0.0.1:3100"); assert.equal(url.pathname, "/api/notion/page"); assert.equal(url.searchParams.get("id"), id);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer readonly-secret"); assert.equal(init?.redirect, "error");
    return Response.json({ ...page, last_edited_time: "2026-10-01", content_truncated: true });
  } });
  assert.equal(references.pages[0].truncated, true); assert.match(references.notices.join(""), /일부만/); assert.doesNotMatch(JSON.stringify(references), /readonly-secret/);
});
test("missing setup, revoked access, mismatched IDs, and upstream secrets become safe notices", async () => {
  assert.match((await readThreadNotionReferences(transcript, {})).notices.join(""), /연결/);
  for (const fetchImpl of [async () => new Response("provider-secret", { status: 404 }), async () => Response.json({ ...page, id: "other" }), async () => { throw new Error("private-secret"); }]) {
    const result = await readThreadNotionReferences(transcript, { serviceUrl: "http://wiki", serviceKey: "key", fetchImpl });
    assert.equal(result.pages.length, 0); assert.doesNotMatch(result.notices.join(""), /private-secret|provider-secret/);
  }
});
test("separates external reference facts from Discord timeline instructions", async () => {
  await summarizeThread({ apiKey: "key", transcript, references: { pages: [page], notices: [] }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.match(body.input, /원문 근거/); assert.match(body.input, /timeline에는 Discord 대화/); assert.match(body.input, /N1/);
    return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(summary) }] }] });
  } });
  const text = formatThreadSummary({ summary: { ...summary, conclusion: ["긴 내용".repeat(1000)] }, guildId: "1", threadId: "2", threadName: "검증", references: { pages: [page], notices: [] } });
  assert.ok(text.length <= 2000); assert.match(text, /## 참고 문서/); assert.match(text, /app.notion.com/);
});
test("thread-summary references require the explicit slash-command option", async () => {
  for (const enabled of [false, true]) {
    let read = false, posted = "";
    const fetchImpl: typeof fetch = async (value, init) => {
      const url = String(value);
      if (url.endsWith("/callback")) return new Response(null, { status: 204 });
      if (url.endsWith("/channels/thread")) return Response.json({ id: "thread", type: 11, parent_id: "parent", guild_id: "guild", name: "검증" });
      if (url.endsWith("/channels/parent")) return Response.json({ type: 0 });
      if (url.endsWith("/channels/parent/messages/thread")) return Response.json({ id: "thread", type: 0 });
      if (url.includes("/channels/thread/messages?")) return Response.json([{ content: transcript, timestamp: "2026-10-01T00:00:00Z", author: { id: "user" } }]);
      if (url.includes("/api/notion/page?")) { read = true; return Response.json(page); }
      if (url.includes("api.openai.com")) return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(summary) }] }] });
      if (url.endsWith("/channels/parent/messages")) { posted = JSON.parse(String(init?.body)).content; return Response.json({ id: "posted" }); }
      if (url.endsWith("/messages/@original")) return Response.json({});
      throw new Error("unexpected request");
    };
    await handleThreadSummaryInteraction({ interaction: { type: 2, data: { name: "스레드-정리", options: enabled ? [{ name: "노션참고", value: true }] : [] }, id: "i", token: "t", application_id: "a", channel_id: "thread" }, token: "test", openAIKey: "test", botUserId: "bot", wikiServiceUrl: "http://wiki", wikiServiceKey: "key", fetchImpl, logger: { error() {} } });
    assert.equal(read, enabled); assert.equal(posted.includes("## 참고 문서"), enabled);
  }
});
