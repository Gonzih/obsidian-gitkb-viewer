import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gitKb = process.env.GITKB_BIN || "git-kb";
const kbRoot = process.env.GITKB_ROOT || process.cwd();

const allowedSmokeCommands = [
  ["--version"],
  ["list", "--json"]
];

for (const args of allowedSmokeCommands) {
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
}

console.log(`Smoke passed using read-only GitKB commands against ${kbRoot}`);
