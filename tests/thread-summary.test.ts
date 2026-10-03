import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadTranscript, formatThreadSummary, threadSummaryCommandDefinition } from "../src/thread-summary.js";

test("메인 버전과 같은 스레드 정리 명령과 익명 시간순 대화문을 만들어요", () => {
  assert.deepEqual(threadSummaryCommandDefinition(), { name: "스레드-정리", description: "현재 스레드를 시간 순 타임라인으로 정리해요.", type: 1, dm_permission: false, options: [{ type: 5, name: "노션참고", description: "스레드의 Notion 링크 원문을 참고 문서로 읽어요.", required: false }] });
  assert.equal(buildThreadTranscript({ botUserId: "999", messages: [{ timestamp: "2026-08-11T02:00:00Z", author: { id: "2" }, content: "확인했어요." }, { timestamp: "2026-08-11T01:00:00Z", author: { id: "1" }, content: "<@2> 확인 부탁해요." }, { timestamp: "2026-08-11T03:00:00Z", author: { id: "999" }, content: "요약" }] }), "[2026-08-11T01:00:00.000Z] 참여자 1: @참여자 2 확인 부탁해요.\n[2026-08-11T02:00:00.000Z] 참여자 2: 확인했어요.");
});

test("3줄 요약과 타임라인을 Discord 형식으로 만들어요", () => {
  const text = formatThreadSummary({ guildId: "1", threadId: "2", threadName: "오디오", summary: { three_line_summary: { problem: "문제", action: "확인", status: "진행" }, timeline: [{ time: "08-11 10:00", event: "점검" }], conclusion: ["재검증"] } });
  assert.match(text, /^# 오디오 스레드 정리/); assert.match(text, /## 3줄 요약/); assert.match(text, /`08-11 10:00` 점검/); assert.match(text, /https:\/\/discord.com\/channels\/1\/2/);
});

const { summarizeThread, ThreadSummaryAIError, handleThreadSummaryInteraction } = await import("../src/thread-summary.js");

for (const scenario of [
  { status: 429, error: { code: "credit_balance_exhausted", type: "insufficient_quota" }, expected: /크레딧이 소진/ },
  { status: 429, error: { code: "insufficient_quota" }, expected: /사용 한도/ },
  { status: 429, error: { code: "rate_limit_exceeded" }, expected: /일시적으로 제한/ },
  { status: 401, error: { code: "invalid_api_key" }, expected: /인증 또는 접근 권한/ },
  { status: 502, error: null, expected: /AI 요약 요청에 실패/ }
]) {
  test(`AI 오류 ${scenario.error?.code || scenario.status}를 구분하고 민감한 응답 본문을 노출하지 않아요`, async () => {
    await assert.rejects(summarizeThread({ apiKey: "test", transcript: "test", fetchImpl: async () => new Response(scenario.error ? JSON.stringify({ error: { ...scenario.error, message: "secret-provider-message" } }) : "bad gateway", { status: scenario.status }) }), (error: unknown) => {
      assert.ok(error instanceof ThreadSummaryAIError);
      assert.match(error.userMessage, scenario.expected);
      assert.doesNotMatch(error.message, /secret-provider-message/);
      return true;
    });
  });
}

test("크레딧 소진 시 원본 채널에 게시하지 않고 명령 사용자에게 원인을 알려요", async () => {
  const calls: string[] = [];
  let result = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/callback")) return new Response(null, { status: 204 });
    if (url.endsWith("/channels/thread")) return Response.json({ id: "thread", type: 11, parent_id: "parent" });
    if (url.endsWith("/channels/parent")) return Response.json({ type: 0 });
    if (url.endsWith("/channels/parent/messages/thread")) return Response.json({ id: "thread", type: 0 });
    if (url.includes("/channels/thread/messages?")) return Response.json([{ content: "테스트", timestamp: "2026-09-28T00:00:00Z", author: { id: "user" } }]);
    if (url.includes("api.openai.com")) return Response.json({ error: { code: "credit_balance_exhausted", type: "insufficient_quota" } }, { status: 429 });
    if (url.endsWith("/messages/@original")) { result = JSON.parse(String(init?.body)).content; return Response.json({}); }
    throw new Error(`Unexpected request: ${url}`);
  };
  assert.equal(await handleThreadSummaryInteraction({ interaction: { type: 2, data: { name: "스레드-정리" }, id: "i", token: "t", application_id: "a", channel_id: "thread" }, token: "test", openAIKey: "test", botUserId: "bot", fetchImpl, logger: { error() {} } }), true);
  assert.match(result, /크레딧이 소진/);
  assert.equal(calls.some(url => url.endsWith("/channels/parent/messages")), false);
});

test("정상 AI 응답은 요약 객체로 반환해요", async () => {
  const summary = { three_line_summary: { problem: "문제", action: "확인", status: "진행" }, timeline: [], conclusion: [] };
  assert.deepEqual(await summarizeThread({ apiKey: "test", transcript: "test", fetchImpl: async () => Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(summary) }] }] }) }), summary);
});

test("Hermes는 API 키 없이 Luna 6 max priority로 내부 서비스만 호출해요", async () => {
  let called = false;
  await summarizeThread({ apiKey: null, transcript: "테스트", provider: "hermes", hermesKey: "bridge-secret", model: "gpt-5-nano", fetchImpl: async (url, init) => {
    called = true;
    assert.equal(url, "http://127.0.0.1:8646/v1/responses");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer bridge-secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-6-luna");
    assert.deepEqual(body.reasoning, { effort: "max" });
    assert.equal(body.service_tier, "priority");
    assert.equal(body.max_output_tokens, 4_000);
    return Response.json({ output: [{ content: [{ type: "output_text", text: '{"three_line_summary":{},"timeline":[],"conclusion":[]}' }] }] });
  } });
  assert.equal(called, true);
});

test("Hermes 오류는 OpenAI 크레딧 충전을 안내하지 않아요", async () => {
  await assert.rejects(summarizeThread({ apiKey: null, transcript: "테스트", provider: "hermes", hermesKey: "bridge-secret", fetchImpl: async () => Response.json({ error: { code: "hermes_summary_failed" } }, { status: 502 }) }), (error: unknown) => {
    assert.ok(error instanceof ThreadSummaryAIError);
    assert.match(error.userMessage, /Hermes/);
    assert.doesNotMatch(error.userMessage, /크레딧/);
    return true;
  });
});
