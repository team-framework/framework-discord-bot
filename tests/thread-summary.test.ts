import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadTranscript, formatThreadSummary, threadSummaryCommandDefinition } from "../src/thread-summary.js";

test("메인 버전과 같은 스레드 정리 명령과 익명 시간순 대화문을 만들어요", () => {
  assert.deepEqual(threadSummaryCommandDefinition(), { name: "스레드-정리", description: "현재 스레드를 시간 순 타임라인으로 정리해요.", type: 1, dm_permission: false });
  assert.equal(buildThreadTranscript({ botUserId: "999", messages: [{ timestamp: "2026-08-11T02:00:00Z", author: { id: "2" }, content: "확인했어요." }, { timestamp: "2026-08-11T01:00:00Z", author: { id: "1" }, content: "<@2> 확인 부탁해요." }, { timestamp: "2026-08-11T03:00:00Z", author: { id: "999" }, content: "요약" }] }), "[2026-08-11T01:00:00.000Z] 참여자 1: @참여자 2 확인 부탁해요.\n[2026-08-11T02:00:00.000Z] 참여자 2: 확인했어요.");
});

test("3줄 요약과 타임라인을 Discord 형식으로 만들어요", () => {
  const text = formatThreadSummary({ guildId: "1", threadId: "2", threadName: "오디오", summary: { three_line_summary: { problem: "문제", action: "확인", status: "진행" }, timeline: [{ time: "08-11 10:00", event: "점검" }], conclusion: ["재검증"] } });
  assert.match(text, /^# 오디오 스레드 정리/); assert.match(text, /## 3줄 요약/); assert.match(text, /`08-11 10:00` 점검/); assert.match(text, /https:\/\/discord.com\/channels\/1\/2/);
});
