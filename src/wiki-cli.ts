import { writeFile } from "node:fs/promises";
import { loadWikiConfig } from "./wiki-config.js";
import { ProposalStore } from "./wiki-store.js";
import { WikiWorkflow, proposalDocument } from "./wiki-workflow.js";

function option(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const config = loadWikiConfig(); const token = process.env.DISCORD_BOT_TOKEN;
if (!config.enabled || !token) throw new Error("위키 기능과 Discord 인증을 설정해 주세요.");
const store = new ProposalStore(config.statePath); const workflow = new WikiWorkflow(config, token, store);
try {
  const bot = await workflow.sources.request("/users/@me") as any; workflow.sources.botUserId = bot.id;
  if (process.argv.includes("--work")) { await workflow.work(); process.stdout.write(JSON.stringify({ pending: store.list("pending").length, approved: store.list("approved").length, published: store.list("published").length }) + "\n"); }
  else {
    const channel = option("--channel"); if (!channel) throw new Error("Usage: wiki-cli --channel <id> [--count 100] [--from <id> --to <id>] [--output <review.md>] [--post]. Preview is the default.");
    const snapshot = await workflow.sources.capture(channel, { count: Number(option("--count") || 100), from: option("--from"), to: option("--to") });
    const proposal = process.argv.includes("--post") ? await workflow.propose(snapshot) : await workflow.proposer.generate(snapshot);
    if (proposal && option("--output")) await writeFile(option("--output")!, proposalDocument(proposal), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ mode: process.argv.includes("--post") ? "posted_for_human_approval" : "preview", message_count: snapshot.messages.length,
      proposal: proposal ? { id: proposal.id, hash: proposal.hash, files: proposal.changes.length, status: proposal.status, notice_id: proposal.notice_id ?? null } : null,
      omissions: snapshot.omissions, generation: workflow.proposer.lastGeneration }) + "\n");
  }
} finally { store.close(); }
