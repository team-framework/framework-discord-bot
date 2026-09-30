import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { WikiConfig } from "./wiki-config.js";
import { digest, StaleProposalError, type Proposal } from "./wiki-types.js";

export class GitHubError extends Error { constructor(readonly status: number) { super(`위키 GitHub 요청에 실패했어요 (${status}).`); } }
export class WikiCoauthorError extends Error {}
export class WikiGitHub {
  private credential: { token: string; until: number } | null = null;
  constructor(readonly config: WikiConfig, readonly fetchImpl = fetch) {}
  private async requestWith(token: string, endpoint: string, method = "GET", body?: unknown) {
    const response = await this.fetchImpl(`https://api.github.com${endpoint}`, { method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "framework-wiki-proposer", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new GitHubError(response.status);
    return response.status === 204 ? null : response.json() as Promise<any>;
  }
  async token() {
    if (this.credential && this.credential.until > Date.now()) return this.credential.token;
    if (this.config.appClientId && this.config.privateKeyPath) {
      const key = await readFile(this.config.privateKeyPath, "utf8"); const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.appClientId })).toString("base64url");
      const signer = createSign("RSA-SHA256"); signer.update(`${header}.${payload}`); signer.end();
      const jwt = `${header}.${payload}.${signer.sign(key, "base64url")}`;
      const installation: any = await this.requestWith(jwt, `/repos/${this.config.repository}/installation`);
      const result: any = await this.requestWith(jwt, `/app/installations/${installation.id}/access_tokens`, "POST", {
        repositories: [this.config.repository.split("/")[1]], permissions: { contents: "write", pull_requests: "write" }
      });
      this.credential = { token: result.token, until: Date.now() + 50 * 60_000 }; return result.token as string;
    }
    if (this.config.githubToken) return this.config.githubToken;
    throw new Error("위키 GitHub App 쓰기 권한을 설정해 주세요.");
  }
  async request(endpoint: string, method = "GET", body?: unknown) { return this.requestWith(await this.token(), endpoint, method, body); }
  async head() {
    const repository = await this.request(`/repos/${this.config.repository}`);
    const ref = await this.request(`/repos/${this.config.repository}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
    return { branch: repository.default_branch as string, sha: ref.object.sha as string };
  }
  async file(filePath: string, ref: string) {
    if (!filePath.endsWith(".md") || filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").some((part) => !part || part === ".." || part === ".")) throw new Error("위키 문서 경로가 올바르지 않아요.");
    try {
      const file = await this.request(`/repos/${this.config.repository}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
      if (file.type !== "file" || file.encoding !== "base64") throw new Error("위키 Markdown 파일을 읽지 못했어요.");
      return { sha: file.sha as string, content: Buffer.from(file.content, "base64").toString("utf8") };
    } catch (error) { if (error instanceof GitHubError && error.status === 404) return null; throw error; }
  }
  async verify(proposal: Proposal) {
    const head = await this.head();
    for (const change of proposal.changes) {
      const file = await this.file(change.path, head.sha);
      if ((file?.sha ?? null) !== change.before_blob || (file ? digest(file.content) : null) !== change.before_hash) throw new StaleProposalError("위키 원본이 바뀌었어요. 변경안을 다시 만들어 승인받아 주세요.");
    }
    return head;
  }
  private async coauthors(proposal: Proposal) {
    const actual = [...new Set(proposal.snapshot.messages.filter((message) => !message.bot && !message.webhook && message.author_id).map((message) => message.author_id))];
    if (actual.length === 0 || actual.length !== proposal.snapshot.participants.length || actual.some((id) => !proposal.snapshot.participants.includes(id))) {
      throw new StaleProposalError("위키 제안의 대화 참여자 목록이 원본과 다릅니다. 제안을 다시 만들어 승인받아 주세요.");
    }
    const mappings = this.config.coauthorUsers;
    const eligible = actual.filter((id) => !this.config.coauthorExcludedDiscordIds.has(id));
    const missing = eligible.filter((id) => !mappings.has(id));
    if (missing.length) throw new WikiCoauthorError(`GitHub 계정 매핑이 없는 대화 참여자 Discord ID: ${missing.join(", ")}. 위키 공동 작성자 매핑을 확인해 주세요.`);
    const trailers: string[] = []; const ids = new Set<number>(); const resolved = new Map<string, { id: number; login: string }>();
    for (const discordId of eligible) {
      const mappedLogin = mappings.get(discordId)!;
      let user = resolved.get(mappedLogin.toLowerCase());
      if (!user) {
        let response: any;
        try { response = await this.request(`/users/${encodeURIComponent(mappedLogin)}`); }
        catch (error) {
          if (error instanceof GitHubError && error.status === 404) throw new WikiCoauthorError(`GitHub 사용자 ${mappedLogin}을 찾지 못했어요. 위키 공동 작성자 매핑을 확인해 주세요.`);
          throw error;
        }
        if (typeof response?.login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(response.login)
          || response.login.toLowerCase() !== mappedLogin.toLowerCase() || !Number.isSafeInteger(response.id) || response.id <= 0 || response.type !== "User") {
          throw new WikiCoauthorError(`GitHub 사용자 ${mappedLogin}의 실제 login과 ID를 확인하지 못했어요. 위키 공동 작성자 매핑을 확인해 주세요.`);
        }
        user = { id: response.id, login: response.login };
        resolved.set(mappedLogin.toLowerCase(), user);
      }
      if (ids.has(user.id)) continue;
      ids.add(user.id);
      trailers.push(`Co-authored-by: ${user.login} <${user.id}+${user.login}@users.noreply.github.com>`);
    }
    return trailers;
  }
  async findPublished(proposal: Proposal) {
    if (!this.config.trackingIssue) throw new Error("WIKI_TRACKING_ISSUE 설정이 필요해요.");
    const headBranch = `feat/discord-wiki-${proposal.id}/#${this.config.trackingIssue}`;
    const marker = `<!-- framework-wiki-proposal:${proposal.id}:${proposal.hash} -->`;
    const repo = `/repos/${this.config.repository}`; const owner = this.config.repository.split("/")[0];
    const pulls = await this.request(`${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${headBranch}`)}&per_page=100`);
    const existing = pulls.find((pull: any) => pull.body?.includes(marker));
    if (!existing) return null;
    for (const change of proposal.changes) {
      const current = await this.file(change.path, existing.head.sha);
      if (!current || digest(current.content) !== change.after_hash) throw new StaleProposalError("기존 PR의 승인된 변경 내용이 바뀌었어요. 관리자 확인이 필요해요.");
    }
    return existing.html_url as string;
  }
  async publish(proposal: Proposal) {
    const existing = await this.findPublished(proposal); if (existing) return existing;
    const headBranch = `feat/discord-wiki-${proposal.id}/#${this.config.trackingIssue}`;
    const marker = `<!-- framework-wiki-proposal:${proposal.id}:${proposal.hash} -->`;
    const repo = `/repos/${this.config.repository}`;
    const head = await this.verify(proposal);
    const coauthors = await this.coauthors(proposal);
    const commitMessage = `feat: Discord 논의 결론을 위키에 반영${coauthors.length ? `\n\n${coauthors.join("\n")}` : ""}`;
    let branchRef: any = null;
    try { branchRef = await this.request(`${repo}/git/ref/heads/${encodeURIComponent(headBranch)}`); }
    catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
    let createdBranch = false;
    if (!branchRef) {
      const commit = await this.request(`${repo}/git/commits/${head.sha}`);
      const tree = await this.request(`${repo}/git/trees`, "POST", { base_tree: commit.tree.sha,
        tree: proposal.changes.map((change) => ({ path: change.path, mode: "100644", type: "blob", content: change.after_content })) });
      const created = await this.request(`${repo}/git/commits`, "POST", { message: commitMessage, tree: tree.sha, parents: [head.sha] });
      try { branchRef = await this.request(`${repo}/git/refs`, "POST", { ref: `refs/heads/${headBranch}`, sha: created.sha }); createdBranch = true; }
      catch (error) { if (!(error instanceof GitHubError) || error.status !== 422) throw error; branchRef = await this.request(`${repo}/git/ref/heads/${encodeURIComponent(headBranch)}`); }
    }
    for (const change of proposal.changes) {
      const current = await this.file(change.path, branchRef.object.sha);
      if (!current || digest(current.content) !== change.after_hash) throw new Error("같은 제안 브랜치에 다른 변경이 있어요. 관리자 확인이 필요해요.");
    }
    if (!createdBranch) {
      const currentCommit = await this.request(`${repo}/git/commits/${branchRef.object.sha}`);
      if (typeof currentCommit.message !== "string" || currentCommit.message.trimEnd() !== commitMessage) throw new StaleProposalError("기존 위키 제안 브랜치의 공동 작성자 정보가 승인된 참여자와 다릅니다. 관리자 확인이 필요해요.");
    }
    await this.verify(proposal);
    const body = `${proposal.conclusion}\n\n${proposal.changes.map((change) => `- ${change.path}`).join("\n")}\n\n출처: ${proposal.snapshot.messages[0].link} ~ ${proposal.snapshot.messages.at(-1)!.link}\n검증 수준: Discord 논의에서 확인한 결정과 사실. 코드·운영 검증은 별도입니다.\n\nRefs #${this.config.trackingIssue}\n${marker}`;
    const created = await this.request(`${repo}/pulls`, "POST", { title: `feat: discord-wiki-${proposal.id}/#${this.config.trackingIssue}`, head: headBranch, base: head.branch, draft: true, body });
    return created.html_url as string;
  }
}
