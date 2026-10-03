export type NotionReference = { id: string; title: string; url: string; content: string; content_hash: string; page_last_edited_at: string; truncated: boolean };
export type NotionReferences = { pages: NotionReference[]; notices: string[] };
export function threadNotionIds(transcript: string) {
  const ids = new Set<string>();
  for (const match of transcript.match(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
    try {
      const url = new URL(match.replace(/[.,;]+$/, ""));
      if (!["notion.so", "www.notion.so", "app.notion.com", "notion.com", "www.notion.com"].includes(url.hostname) && !url.hostname.endsWith(".notion.site")) continue;
      const id = url.pathname.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i)?.[1];
      if (id) ids.add(id.replaceAll("-", "").toLowerCase());
    } catch { /* Ignore malformed and unrelated links. */ }
  }
  return [...ids];
}
export async function readThreadNotionReferences(transcript: string, options: { serviceUrl?: string; serviceKey?: string | null; fetchImpl?: typeof fetch }): Promise<NotionReferences> {
  const ids = threadNotionIds(transcript); const result: NotionReferences = { pages: [], notices: [] };
  if (!ids.length) return result;
  if (!options.serviceUrl || !options.serviceKey) return { pages: [], notices: ["Notion 조회 연결을 준비해야 해요."] };
  if (ids.length > 3) result.notices.push("Notion 문서는 최대 3개까지 참고했어요.");
  for (const id of ids.slice(0, 3)) {
    try {
      const url = new URL("/api/notion/page", options.serviceUrl); url.searchParams.set("id", id); url.searchParams.set("max_chars", "6000");
      const response = await (options.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${options.serviceKey}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const text = await response.text(); if (text.length > 12_000) throw new Error();
      const page = JSON.parse(text);
      if (typeof page.id !== "string" || page.id.replaceAll("-", "").toLowerCase() !== id || typeof page.title !== "string" || typeof page.content !== "string" || typeof page.content_hash !== "string") throw new Error();
      result.pages.push({ id, title: page.title.slice(0, 200), url: `https://app.notion.com/p/${id}`, content: page.content,
        content_hash: page.content_hash, page_last_edited_at: typeof page.last_edited_time === "string" ? page.last_edited_time : "", truncated: Boolean(page.truncated || page.content_truncated) });
      if (page.truncated || page.content_truncated) result.notices.push("참고 문서의 본문을 일부만 읽었어요.");
    } catch { result.notices.push("Notion 문서 일부를 조회하지 못했어요. 페이지 접근 범위와 서버 연결을 확인해 주세요."); }
  }
  result.notices = [...new Set(result.notices)]; return result;
}
