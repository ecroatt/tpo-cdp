// PreToolUse hook: stops Claude from reading or editing secret files.
// Claude Code sends the tool call as JSON on stdin.
// Exiting with code 2 blocks the call and shows our message to Claude.

const BLOCKED = [
  { pattern: /(^|[\\/\s"'=])\.env(\.[\w.-]+)?($|[\s"'\\/;|&)])/i, label: ".env file" },
  { pattern: /(^|[\\/\s"'=])\.dev\.vars(\.[\w.-]+)?($|[\s"'\\/;|&)])/i, label: ".dev.vars file" },
  { pattern: /(^|[\\/\s"'=~])\.aws([\\/]|$|[\s"';|&)])/i, label: "~/.aws folder" },
];

// Template files hold no real secrets, so they stay allowed.
const ALLOWED = /\.(env|dev\.vars)\.example\b/gi;

function findBlocked(text) {
  const cleaned = text.replace(ALLOWED, "");
  return BLOCKED.find((rule) => rule.pattern.test(cleaned));
}

function textToCheck(toolName, input) {
  if (toolName === "Bash" || toolName === "PowerShell") return input.command || "";
  // Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob
  return [input.file_path, input.notebook_path, input.path, input.pattern, input.glob]
    .filter(Boolean)
    .join(" ");
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let call;
  try {
    call = JSON.parse(raw);
  } catch {
    process.exit(0); // Not something we understand; let it through.
  }

  const hit = findBlocked(textToCheck(call.tool_name, call.tool_input || {}));
  if (hit) {
    console.error(
      `Blocked: this would touch a ${hit.label}, which may hold secrets. ` +
        "Ask the user to make this change themselves."
    );
    process.exit(2);
  }
  process.exit(0);
});
