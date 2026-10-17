// Stop hook: runs the test suite before Claude finishes if worker/ has changes.
// Claude Code sends the hook input as JSON on stdin.
// Exit 0 lets Claude stop. Exit 2 sends stderr back to Claude and keeps it working.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const TAIL_LINES = 40;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

function allow() {
  process.exit(0);
}

function hasWorkerChanges(repoRoot) {
  const status = spawnSync("git", ["status", "--porcelain", "--", "worker/"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (status.error || status.status !== 0) return false;
  return status.stdout.trim().length > 0;
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    allow();
  }

  // Already blocked once this turn; do not loop.
  if (input.stop_hook_active === true) allow();

  const repoRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  if (!hasWorkerChanges(repoRoot)) allow();

  const run = spawnSync("npm", ["test"], {
    cwd: path.join(repoRoot, "worker"),
    encoding: "utf8",
    shell: true, // npm is npm.cmd on Windows
    timeout: TEST_TIMEOUT_MS,
  });

  if (run.status === 0) allow();

  const output = `${run.stdout || ""}${run.stderr || ""}`.trimEnd().split(/\r?\n/);
  const reason = run.error ? `npm test did not finish: ${run.error.message}\n` : "";
  console.error(
    `${reason}npm test failed. Last ${TAIL_LINES} lines:\n${output.slice(-TAIL_LINES).join("\n")}`
  );
  process.exit(2);
});
