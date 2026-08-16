export type Notification = {
  repository: string;
  title: string;
  url: string;
  body: string | null;
  recipients: string[];
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function user(payload: any) {
  return text(payload?.login);
}

function prTitle(pr: any) {
  return text(pr?.title) || "제목 없는 PR";
}

function prUrl(pr: any, repository: string) {
  return text(pr?.html_url) || `https://github.com/${repository}/pull/${pr?.number}`;
}

function commentBody(comment: any) {
  const body = text(comment?.body);
  return body ? body.slice(0, 1_000) : null;
}

export function notificationFor(event: string, payload: any, prOpenRoleId: string | null): Notification | null {
  const repository = text(payload?.repository?.full_name);
  const pr = payload?.pull_request || (event === "issue_comment" && payload?.issue?.pull_request ? payload.issue : null);
  if (!repository || !pr) return null;
  const author = user(pr.user);
  const actor = user(payload.sender) || "GitHub 사용자";

  if (event === "pull_request" && payload.action === "opened") {
    return { repository, title: `PR 열림 · ${prTitle(pr)}`, url: prUrl(pr, repository), body: `${actor}님이 PR을 열었어요.`, recipients: prOpenRoleId ? [`role:${prOpenRoleId}`] : [] };
  }
  if (event === "pull_request" && payload.action === "review_requested") {
    const reviewer = user(payload.requested_reviewer);
    return { repository, title: `리뷰 요청 · ${prTitle(pr)}`, url: prUrl(pr, repository), body: reviewer ? `${actor}님이 ${reviewer}님에게 리뷰를 요청했어요.` : `${actor}님이 리뷰를 요청했어요.`, recipients: reviewer ? [reviewer] : [] };
  }
  if (event === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
    return { repository, title: `PR 댓글 · ${prTitle(pr)}`, url: text(payload.comment?.html_url) || prUrl(pr, repository), body: commentBody(payload.comment), recipients: author && author !== actor ? [author] : [] };
  }
  if (event === "pull_request_review_comment" && payload.action === "created") {
    return { repository, title: `코드 리뷰 댓글 · ${prTitle(pr)}`, url: text(payload.comment?.html_url) || prUrl(pr, repository), body: commentBody(payload.comment), recipients: author && author !== actor ? [author] : [] };
  }
  if (event === "pull_request" && payload.action === "closed" && Boolean(pr.merged)) {
    return { repository, title: `PR 병합 · ${prTitle(pr)}`, url: prUrl(pr, repository), body: `${actor}님이 PR을 병합했어요.`, recipients: author ? [author] : [] };
  }
  return null;
}
