import type { Plugin } from "@opencode-ai/plugin"
import { dumpCapSessions, standInRecoveryInFlight } from "./shared-session-state.ts"

const SERVICE = "tool-not-shell"
const CONFIRM_RE = /#\s*confirm\s*$/i
const BYPASS = 'To run this in bash anyway, append `# confirm`.'

/** Inject recovery after this many identical stand-in commands. */
const MAX_IDENTICAL_STANDIN = 2
const SENTINEL = "Shell stand-in loop recovery:"

type SessionState = {
  /** Stand-in token -> times blocked this session. */
  blocked: Map<string, number>
  /** Normalized stand-in command -> times blocked. */
  commands: Map<string, number>
  /** Commands we already sent recovery for. */
  recoverySent: Set<string>
}

const sessions = new Map<string, SessionState>()

function sessionState(sessionID: string): SessionState {
  let st = sessions.get(sessionID)
  if (!st) {
    st = { blocked: new Map(), commands: new Map(), recoverySent: new Set() }
    sessions.set(sessionID, st)
  }
  return st
}

function recordBlock(sessionID: string, token: string): number {
  const st = sessionState(sessionID)
  const count = (st.blocked.get(token) ?? 0) + 1
  st.blocked.set(token, count)
  return count
}

function recordCommandBlock(sessionID: string, key: string): number {
  const st = sessionState(sessionID)
  const count = (st.commands.get(key) ?? 0) + 1
  st.commands.set(key, count)
  return count
}

function stripStatementPrefix(statement: string): string {
  return statement.trim().replace(/^(\w+=\S+\s+)+/, "").replace(/^cd\s+\S+\s+&&\s+/i, "")
}

function standInTarget(statement: string, token: string): string | null {
  const s = stripStatementPrefix(statement)
  const match = new RegExp(`^${token}\\s+(\\S+)`, "i").exec(s)
  return match?.[1]?.replace(/^["']|["']$/g, "") ?? null
}

function standInCommandKey(statement: string, token: string): string {
  const target = standInTarget(statement, token)
  return target ? `${token}:${target}` : `${token}:${stripStatementPrefix(statement).replace(/\s+/g, " ").slice(0, 120)}`
}

function recoveryText(token: string, target: string | null, atDumpCap: boolean): string {
  const readHint = target
    ? `Use the grep tool with pattern and path \`${target}\`, or continue from files already read. `
    : "Use grep or continue from files already read. "
  const dumpHint = atDumpCap
    ? "The read tool hit its session cap — cat in bash is also blocked and will never work. "
    : ""
  return (
    `${SENTINEL} Stop running \`${token}\` in bash. ${dumpHint}${readHint}` +
    "Do not retry this shell command."
  )
}

function blockMessage(
  token: string,
  hint: string,
  count: number,
  cmdCount: number,
  target: string | null,
  atDumpCap: boolean,
): string {
  if (atDumpCap && (token === "cat" || token === "head" || token === "tail" || token === "less")) {
    return (
      `Read cap is full and \`${token}\` in bash is blocked. ${hint} ` +
      (target ? `Use grep on \`${target}\` or proceed with files already in context. ` : "") +
      "Do not retry cat/head/tail in bash. " +
      BYPASS
    )
  }
  if (cmdCount >= 2 || count >= 2) {
    return (
      `Shell stand-in loop: \`${token}\` in bash was blocked ${cmdCount} time(s) for the same command. ` +
      "Stop retrying in bash. " +
      hint +
      (target && token === "cat" ? ` Use read with filePath or grep on \`${target}\`. ` : " ") +
      (atDumpCap ? "Read cap is full — grep only, not cat. " : "") +
      BYPASS
    )
  }
  return (
    `\`${token}\` is not a bash stand-in for an OpenCode tool. ${hint} ` +
    "Do not retry this in bash — use the OpenCode tool on the next turn. " +
    BYPASS
  )
}

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
        const cmdKey = standInCommandKey(statement, match.token)
        const target = standInTarget(statement, match.token)
        const count = recordBlock(input.sessionID, match.token)
        const cmdCount = recordCommandBlock(input.sessionID, cmdKey)
        const atDumpCap = dumpCapSessions.has(input.sessionID)
        const st = sessionState(input.sessionID)

        if (
          cmdCount > MAX_IDENTICAL_STANDIN &&
          !st.recoverySent.has(cmdKey) &&
          !standInRecoveryInFlight.has(input.sessionID)
        ) {
          st.recoverySent.add(cmdKey)
          standInRecoveryInFlight.add(input.sessionID)
          const recovery = recoveryText(match.token, target, atDumpCap)
          await log("injecting shell stand-in recovery", {
            sessionID: input.sessionID,
            token: match.token,
            cmdKey,
            cmdCount,
          })
          try {
            await client.session.promptAsync({
              path: { id: input.sessionID },
              body: { parts: [{ type: "text", text: recovery }] },
            })
          } finally {
            standInRecoveryInFlight.delete(input.sessionID)
          }
        }

        await log("blocked shell stand-in", {
          sessionID: input.sessionID,
          token: match.token,
          count,
          cmdCount,
          atDumpCap,
        })
        throw new Error(
          blockMessage(match.token, match.hint, count, cmdCount, target, atDumpCap),
        )
      }
    },
  }
}
