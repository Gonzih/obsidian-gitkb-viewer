import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

const forbiddenCommands = [
  "checkout",
  "commit",
  "create",
  "set",
  "rm",
  "mv",
  "reset",
  "clear",
  "stash",
  "pull",
  "push",
  "repair",
  "reindex",
  "project",
  "projections"
];

const allowlistBlock = source.match(/function assertAllowedGitKbArgs[\s\S]*?\n}\n/);
if (!allowlistBlock) {
  throw new Error("Could not find assertAllowedGitKbArgs allowlist.");
}

for (const command of forbiddenCommands) {
  if (allowlistBlock[0].includes(`"${command}"`) || allowlistBlock[0].includes(`'${command}'`)) {
    throw new Error(`Forbidden command appears in allowlist: ${command}`);
  }
}

const requiredAllowed = [
  '"--version"',
  '"list"',
  '"show"',
  '"search"',
  '"board"',
  '"graph"'
];

for (const command of requiredAllowed) {
  if (!allowlistBlock[0].includes(command)) {
    throw new Error(`Required readonly command missing from allowlist: ${command}`);
  }
}

console.log("Readonly allowlist verification passed.");
