import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "tool-not-shell"
const CONFIRM_RE = /#\s*confirm\s*$/i
const BYPASS = 'To run this in bash anyway, append `# confirm`.'

/** OpenCode tools that are not Unix programs. */
const TOOL_AS_SHELL: Record<string, string> = {
  edit: "Call the edit tool with filePath, oldString, and newString.",
  write: "Call the write tool with filePath and content.",
  glob: "Call the glob tool with a pattern.",
  webfetch: "Call the webfetch tool with a URL.",
  todowrite: "Call the todowrite tool with the todo list.",
}

/** Unix programs that should be dedicated OpenCode tools instead. */
const UNIX_AS_TOOL: Record<string, (statement: string) => string> = {
  cat: (s) =>
    hasOutputRedirect(s)
      ? "Call the write tool with filePath and content (or edit to append)."
      : "Call the read tool with the file path.",
  sed: (s) =>
    /(^|\s)-i\b/.test(s)
      ? "Call the edit tool with filePath, oldString, and newString."
      : "Call the grep tool to search, or edit to change a file.",
  awk: () => "Call the grep tool to search, or read to inspect a file.",
  find: () => "Call the glob tool with a pattern, or grep to search file contents.",
  ls: () => "Call the glob tool with a pattern (for example `**/*`).",
  tree: () => "Call the glob tool with a pattern.",
  dir: () => "Call the glob tool with a pattern.",
  grep: () => "Call the grep tool with pattern and path.",
  egrep: () => "Call the grep tool with pattern and path.",
  fgrep: () => "Call the grep tool with pattern and path.",
  rg: () => "Call the grep tool with pattern and path.",
  ag: () => "Call the grep tool with pattern and path.",
  head: () => "Call the read tool. Use offset/limit instead of head.",
  tail: () => "Call the read tool. Use a negative offset instead of tail.",
  less: () => "Call the read tool with the file path.",
  more: () => "Call the read tool with the file path.",
  bat: () => "Call the read tool with the file path.",
  nl: () => "Call the read tool with the file path.",
  touch: () => "Call the write tool with filePath and content.",
}

function firstToken(command: string): string {
  const trimmed = command.trim().replace(/^(\w+=\S+\s+)+/, "")
  const match = trimmed.match(/^([A-Za-z0-9._+-]+)/)
  if (!match) return ""
  return match[1].replace(/^.*\//, "").toLowerCase()
}

function looksLikeReadPath(command: string): boolean {
  const trimmed = command.trim().replace(/^(\w+=\S+\s+)+/, "")
  const match = trimmed.match(/^read\s+(\S+)/)
  if (!match) return false
  const arg = match[1]
  if (arg.startsWith("-")) return false
  return arg.includes("/") || /\.\w{1,8}$/.test(arg)
}

function hasOutputRedirect(command: string): boolean {
  const stripped = command
    .replace(/\d*>>?\s*\/dev\/null/g, "")
    .replace(/\d*>&\d+/g, "")
    .replace(/&>\s*\/dev\/null/g, "")
  return /(?:^|[\s;|&])>>?\s*(?!\/dev\/null)\S+/.test(stripped)
}

function splitStatements(command: string): string[] {
  const out: string[] = []
  let buf = ""
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const prev = command[i - 1]
    if (quote) {
      buf += c
      if (c === quote && prev !== "\\") quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      buf += c
      continue
    }
    if (c === "#" && (buf === "" || /\s$/.test(buf))) break
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      i++
      continue
    }
    if (c === ";" || c === "\n") {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function changeName(flag: "--change" | "--changes", statement: string): string | undefined {
  const re =
    flag === "--change"
      ? /(?:^|[\s])--change(?:\s+|=)(["']?)([A-Za-z][\w.-]*)\1/
      : /(?:^|[\s])--changes(?:\s+|=)(["']?)([A-Za-z][\w.-]*)\1/
  return re.exec(statement)?.[2]
}

function openspecValidateHint(statement: string): string | null {
  if (!/\bopenspec\b/.test(statement) || !/\bvalidate\b/.test(statement)) return null
  const hasChange = /(?:^|[\s])--change(?:[\s=]|$)/.test(statement)
  const hasChanges = /(?:^|[\s])--changes(?:[\s=]|$)/.test(statement)
  if (hasChange && !hasChanges) {
    const name = changeName("--change", statement)
    const cmd = name ? `openspec validate "${name}"` : 'openspec validate "<name>"'
    return `\`openspec validate\` has no \`--change\` flag (that flag is for status/instructions). Run \`${cmd}\`.`
  }
  const changesName = changeName("--changes", statement)
  if (hasChanges && changesName) {
    return `\`--changes\` validates every change and takes no name. To validate one change, run \`openspec validate "${changesName}"\`.`
  }
  return null
}

function hintFor(statement: string): { token: string; hint: string } | null {
  const token = firstToken(statement)
  if (!token) return null
  if (TOOL_AS_SHELL[token]) return { token, hint: TOOL_AS_SHELL[token] }
  if (token === "read" && looksLikeReadPath(statement)) {
    return { token, hint: "Call the read tool with the file path." }
  }
  const unix = UNIX_AS_TOOL[token]
  if (unix) return { token, hint: unix(statement) }
  return null
}

export const ToolNotShellPlugin: Plugin = async ({ client }) => {
  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({
        body: { service: SERVICE, level: "info", message, extra },
      })
    } catch {
      // Logging must never break the session.
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = typeof output.args?.command === "string" ? output.args.command : ""
      if (!command.trim() || CONFIRM_RE.test(command)) return

      for (const statement of splitStatements(command)) {
        const openspecHint = openspecValidateHint(statement)
        if (openspecHint) {
          await log("blocked invalid openspec validate", { sessionID: input.sessionID })
          throw new Error(openspecHint)
        }
        const match = hintFor(statement)
        if (!match) continue
        await log("blocked shell stand-in", {
          sessionID: input.sessionID,
          token: match.token,
        })
        throw new Error(
          `\`${match.token}\` is not a bash stand-in for an OpenCode tool. ${match.hint} ${BYPASS}`,
        )
      }
    },
  }
}
