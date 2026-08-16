import assert from "node:assert/strict";
import test from "node:test";
import { messagePayload } from "../src/discord.js";
import { notificationFor } from "../src/events.js";

const base = { repository: { full_name: "team-framework/innolive-client" }, sender: { login: "reviewer" }, pull_request: { number: 2, title: "feat: stream", html_url: "https://github.com/team-framework/innolive-client/pull/2", user: { login: "author" } } };

test("요청한 PR 이벤트만 알림으로 변환해요", () => {
  assert.equal(notificationFor("issues", { ...base, action: "opened" }, null), null);
  assert.equal(notificationFor("create", { ...base, action: "create" }, null), null);
  assert.equal(notificationFor("pull_request", { ...base, action: "synchronize" }, null), null);
  assert.equal(notificationFor("pull_request", { ...base, action: "opened" }, "123456789012345678")?.title, "PR 열림 · feat: stream");
  assert.deepEqual(notificationFor("pull_request", { ...base, action: "review_requested", requested_reviewer: { login: "reviewer" } }, null)?.recipients, ["reviewer"]);
  assert.equal(notificationFor("pull_request", { ...base, action: "review_requested", requested_team: { slug: "backend" } }, null), null);
  const { pull_request: _ignored, ...issueCommentPayload } = base;
  assert.deepEqual(notificationFor("issue_comment", { ...issueCommentPayload, action: "created", issue: { ...base.pull_request, pull_request: {} }, comment: { body: "확인 부탁해요" } }, null)?.recipients, ["author"]);
  assert.deepEqual(notificationFor("pull_request", { ...base, action: "closed", pull_request: { ...base.pull_request, merged: true } }, null)?.recipients, ["author"]);
});

test("허용된 사용자와 역할만 Discord 멘션으로 전송해요", () => {
  const payload = messagePayload({ title: "리뷰 요청", url: "https://example.com", body: null, recipients: ["reviewer", "role:123456789012345678"] }, new Map([["reviewer", "234567890123456789"]]));
  assert.equal(payload.content, "<@234567890123456789> <@&123456789012345678>");
  assert.deepEqual(payload.allowed_mentions, { parse: [], users: ["234567890123456789"], roles: ["123456789012345678"] });
  assert.equal(messagePayload({ title: "리뷰 요청", url: "https://example.com", body: null, recipients: ["unmapped-reviewer"] }, new Map()).content, undefined);
});
