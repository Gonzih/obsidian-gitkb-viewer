import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gitKb = process.env.GITKB_BIN || "git-kb";
const kbRoot = process.env.GITKB_ROOT || process.cwd();

async function runGitKb(args) {
  const { stdout } = await execFileAsync(gitKb, args, {
    cwd: kbRoot,
    env: {
      ...process.env,
      GITKB_ROOT: kbRoot
    },
    maxBuffer: 1024 * 1024 * 20,
    timeout: 30_000
  });

  if (!stdout.trim()) {
    throw new Error(`Smoke command produced no output: ${gitKb} ${args.join(" ")}`);
  }

  return stdout;
}

await runGitKb(["--version"]);
const listOutput = await runGitKb(["list", "--json"]);
const docs = JSON.parse(listOutput);
if (!Array.isArray(docs) || docs.length === 0 || typeof docs[0].slug !== "string") {
  throw new Error("Smoke list command did not return a document array with slugs.");
}
await runGitKb(["graph", docs[0].slug, "--json"]);

console.log(`Smoke passed using read-only GitKB commands against ${kbRoot}`);
