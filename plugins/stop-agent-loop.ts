import type { Plugin } from "@opencode-ai/plugin"
import {
  dumpCapSessions,
  isChildSession,
  isExploreSession,
  isNemotronSession,
  recordToolBlock,
  rememberSessionModel,
} from "./shared-session-state.ts"
import { isRedirectedBash } from "./tool-not-shell.ts"

const SERVICE = "stop-agent-loop"
const CONFIRM_RE = /#\s*confirm\s*$/i
const PATH_CONFIRM_KEYS = ["filePath", "path", "pattern", "glob_pattern", "command"] as const

/** Block the 3rd identical tool call (git diff, read, edit, grep, …). */
const MAX_SAME_CALL = 2
/** Nemotron: allow more verify retries before treating as a stuck loop. */
const MAX_SAME_CALL_NEMOTRON = 5
/** Primary apply: non-lookup steps (bash verify, failed edits) before a write. */
const MAX_NO_PROGRESS_PRIMARY = 20
/** Nemotron: multi-commit / split workflows need more status/diff/log headroom. */
const MAX_NO_PROGRESS_PRIMARY_NEMOTRON = 48
/** Child @explore/@general: answer sooner once lookups are done. */
const MAX_NO_PROGRESS_CHILD = 12
const MAX_NO_PROGRESS_CHILD_NEMOTRON = 24
/** Child explore: unique read/grep/glob identities before forcing findings. */
const MAX_CHILD_UNIQUE_LOOKUPS = 20

const LOOKUP_TOOLS = new Set(["read", "grep", "glob"])
/** Still allowed after the no-progress cap — these are the recovery path. */
const RECOVERY_TOOLS = new Set(["write", "edit", "question"])
/** Bootstrap / orchestration — do not consume the no-progress budget. */
const META_TOOLS = new Set(["skill", "task", "todowrite", "todo"])

type SessionState = {
  calls: Map<string, number>
  stepsSinceProgress: number
  firstPass: Set<string>
}

const sessions = new Map<string, SessionState>()

function state(sessionID: string): SessionState {
  let st = sessions.get(sessionID)
  if (!st) {
    st = { calls: new Map(), stepsSinceProgress: 0, firstPass: new Set() }
    sessions.set(sessionID, st)
  }
  return st
}

function markProgress(sessionID: string) {
  state(sessionID).stepsSinceProgress = 0
}

function clearGitVerifyRepeatState(sessionID: string): number {
  const st = state(sessionID)
  let cleared = 0
  for (const key of [...st.calls.keys()]) {
    if (
      key === "bash:git-status" ||
      key === "bash:git-log" ||
      key.startsWith("bash:git-diff:") ||
      key.startsWith("bash:git-show:")
    ) {
      st.calls.delete(key)
      cleared += 1
    }
  }
  return cleared
}

function stripShellPrefix(command: string): string {
  return command
    .trim()
    .replace(/^(\w+=\S+\s+)+/, "")
    .replace(/^cd\s+\S+\s+&&\s+/gi, "")
    .replace(/\s+2>&1/g, "")
    .replace(/\s+\|\s*(tail|head|sed|grep|wc|sort|uniq|cat)(?:\s+[^\|]*)?$/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Staging/committing is real session progress (and often the *goal*), not
 * verify-loop noise. Exempt from the no-progress cap; reset the counter after
 * a successful run. Without this, a long git-log/status explore burns the
 * budget and then blocks the eventual `git add` / `git commit`.
 */
function isGitMutatingBash(command: string): boolean {
  const s = stripShellPrefix(command)
  if (!s) return false
  // Direct: `git add`, `git -C path commit`, or chained `git add -A && git commit …`
  if (/\bgit(?:\s+-C\s+\S+)?\s+(?:add|commit)\b/.test(s)) return true
  // Indirect: python subprocess.run(['git', 'add'| 'commit', …])
  if (
    /subprocess\.run\s*\(/.test(s) &&
    /['"]git['"]/.test(s) &&
    /['"](?:add|commit)['"]/.test(s)
  ) {
    return true
  }
  return false
}

function normalizeBash(command: string): string {
  const s = stripShellPrefix(command)
  if (!s) return "bash:empty"

  if (/^git diff\b/.test(s) || /\bgit diff\b/.test(s)) {
    const files = [...s.matchAll(/\s--\s+(\S+)/g)].map((m) => m[1]).join(",")
    return `bash:git-diff:${files || "tree"}`
  }
  if (/^git status\b/.test(s)) return "bash:git-status"
  if (/^git show\b/.test(s)) return `bash:git-show:${s.slice(0, 80)}`
  if (/^git log\b/.test(s)) return "bash:git-log"
  if (/\bpytest\b/.test(s)) {
    const node =
      s.match(/(?:^|\s)(tests\/[^\s'"]+(?:::[\w\[\]-]+)?)/)?.[1] ??
      s.match(/(?:^|\s)([^\s'"]+\.py(?:::[\w\[\]-]+)?)/)?.[1] ??
      s.slice(0, 100)
    return `bash:pytest:${node}`
  }
  if (/^openspec\b/.test(s)) {
    return `bash:openspec:${s.split(/\s+/).slice(0, 4).join("-")}`
  }
  if (/^python\s+-c\b/.test(s) || /^uv\s+run\s+python\s+-c\b/.test(s)) {
    return `bash:python-c:${s.slice(0, 120)}`
  }

  return `bash:${s.slice(0, 160)}`
}

function callKey(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash") {
    return normalizeBash(String(args.command ?? ""))
  }
  if (tool === "read") {
    const path = String(args.filePath ?? args.path ?? "")
    const offset = args.offset ?? ""
    const limit = args.limit ?? ""
    return `read:${path}:${offset}:${limit}`
  }
  if (tool === "edit") {
    const path = String(args.filePath ?? args.path ?? "")
    const old = String(args.oldString ?? args.old_string ?? "").slice(0, 120)
    return `edit:${path}:${old}`
  }
  if (tool === "write") {
    return `write:${String(args.filePath ?? args.path ?? "")}`
  }
  if (tool === "grep") {
    return `grep:${String(args.pattern ?? "")}:${String(args.path ?? "")}`
  }
  if (tool === "glob") {
    return `glob:${String(args.pattern ?? args.glob_pattern ?? "")}`
  }

  return `${tool}:${JSON.stringify(args).slice(0, 180)}`
}

function uniqueLookupCount(st: SessionState): number {
  let n = 0
  for (const key of st.firstPass) {
    if (key.startsWith("read:") || key.startsWith("grep:") || key.startsWith("glob:")) n += 1
  }
  return n
}

/** Identity for first-pass lookups — path/pattern, ignoring offset/limit. */
function lookupIdentity(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "read") {
    const path = String(args.filePath ?? args.path ?? "")
    return path ? `read:${path}` : null
  }
  if (tool === "grep") {
    return `grep:${String(args.pattern ?? "")}:${String(args.path ?? "")}`
  }
  if (tool === "glob") {
    return `glob:${String(args.pattern ?? args.glob_pattern ?? "")}`
  }
  if (tool === "bash") {
    const key = normalizeBash(String(args.command ?? ""))
    if (key.startsWith("bash:openspec:")) return key
  }
  return null
}

function hasConfirmMarker(value: unknown): boolean {
  if (typeof value === "boolean") return value === true
  if (typeof value === "string") return CONFIRM_RE.test(value)
  if (Array.isArray(value)) return value.some(hasConfirmMarker)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasConfirmMarker)
  }
  return false
}

function isConfirmBypass(args: Record<string, unknown>): boolean {
  if (args.confirm === true) return true
  return hasConfirmMarker(args)
}

function stripConfirmFromPathArgs(args: Record<string, unknown>) {
  for (const key of PATH_CONFIRM_KEYS) {
    const value = args[key]
    if (typeof value !== "string" || !CONFIRM_RE.test(value)) continue
    args[key] = value.replace(CONFIRM_RE, "").trimEnd()
  }
}

function repeatMessage(tool: string, key: string, count: number): string {
  const hint =
    tool === "bash" && key.includes("git-diff")
      ? "The diff is already in context. Edit the file, mark the OpenSpec task done, or say what is still wrong."
      : "Use the prior output. Edit code, mark the task done, or explain the blocker — do not rerun this call."

  return (
    `Agent loop: the same ${tool} call already ran ${count} time(s) this session. ${hint} ` +
    "Append `# confirm` to the tool arguments to run anyway."
  )
}

function noProgressMessage(steps: number, child: boolean): string {
  return (
    `Agent loop: ${steps} non-lookup tool calls without a successful write/edit. ` +
    (child
      ? "Close out with findings — do not keep exploring."
      : "Stop verifying (git diff, pytest, re-reads). You may still write/edit code, edit openspec tasks.md, run git add/commit, or use the question tool.") +
    " Append `# confirm` to the tool arguments to continue anyway."
  )
}

function childLookupCapMessage(count: number): string {
  return (
    `Explore already looked up ${count} files/patterns. Close out with findings — ` +
    "do not keep exploring. You may still write a summary; do not read more files. " +
    "Append `# confirm` to the tool arguments to continue anyway."
  )
}

export const StopAgentLoopPlugin: Plugin = async ({ client }) => {
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
    "chat.params": async (input) => {
      rememberSessionModel(input.sessionID, String(input.model?.id ?? ""))
    },

    "tool.execute.before": async (input, output) => {
      const args = (output.args ?? {}) as Record<string, unknown>
      if (isConfirmBypass(args)) {
        stripConfirmFromPathArgs(args)
        return
      }

      const st = state(input.sessionID)
      const child = isChildSession(input.sessionID)
      const explore = isExploreSession(input.sessionID)
      const nemotron = isNemotronSession(input.sessionID)
      const maxSameCall = nemotron ? MAX_SAME_CALL_NEMOTRON : MAX_SAME_CALL
      const maxNoProgress = child
        ? nemotron
          ? MAX_NO_PROGRESS_CHILD_NEMOTRON
          : MAX_NO_PROGRESS_CHILD
        : nemotron
          ? MAX_NO_PROGRESS_PRIMARY_NEMOTRON
          : MAX_NO_PROGRESS_PRIMARY

      if (
        input.tool === "bash" &&
        isRedirectedBash(String(args.command ?? ""), dumpCapSessions.has(input.sessionID))
      ) {
        await log("skipped no-progress for redirected bash", {
          sessionID: input.sessionID,
          command: String(args.command ?? "").slice(0, 80),
        })
        return
      }

      if (META_TOOLS.has(input.tool) || input.tool === "question") {
        return
      }

      const gitMutating =
        input.tool === "bash" && isGitMutatingBash(String(args.command ?? ""))

      const identity = lookupIdentity(input.tool, args)
      const firstPassLookup = Boolean(identity) && !st.firstPass.has(identity!)
      if (firstPassLookup && identity) {
        if (explore && LOOKUP_TOOLS.has(input.tool)) {
          const lookupCount = uniqueLookupCount(st)
          if (lookupCount >= MAX_CHILD_UNIQUE_LOOKUPS) {
            await recordToolBlock(client, input.sessionID, "explore-lookup-cap")
            await log("blocked explore unique-lookup cap", {
              sessionID: input.sessionID,
              uniqueLookups: lookupCount,
              tool: input.tool,
            })
            throw new Error(childLookupCapMessage(lookupCount))
          }
        }
        st.firstPass.add(identity)
        await log("first-pass lookup exempt from no-progress", {
          sessionID: input.sessionID,
          identity,
        })
      }

      const countsTowardNoProgress =
        !firstPassLookup &&
        !gitMutating &&
        !(RECOVERY_TOOLS.has(input.tool) && st.stepsSinceProgress > maxNoProgress)
      if (countsTowardNoProgress) {
        st.stepsSinceProgress += 1
      }

      const overCap = st.stepsSinceProgress > maxNoProgress
      const allowedAfterCap = RECOVERY_TOOLS.has(input.tool) || gitMutating
      if (overCap && !allowedAfterCap) {
        await recordToolBlock(client, input.sessionID, "no-progress")
        await log("blocked no-progress loop", {
          sessionID: input.sessionID,
          steps: st.stepsSinceProgress,
          child,
          tool: input.tool,
        })
        throw new Error(noProgressMessage(st.stepsSinceProgress, child))
      }

      if (overCap && allowedAfterCap) {
        await log("allowed recovery tool after no-progress cap", {
          sessionID: input.sessionID,
          tool: input.tool,
          steps: st.stepsSinceProgress,
          gitMutating,
        })
      }

      const key = callKey(input.tool, args)
      const prior = st.calls.get(key) ?? 0
      if (prior >= maxSameCall) {
        await recordToolBlock(client, input.sessionID, `repeat:${input.tool}`)
        await log("blocked repeat tool call", {
          sessionID: input.sessionID,
          tool: input.tool,
          key,
          count: prior + 1,
          nemotron,
          maxSameCall,
        })
        throw new Error(repeatMessage(input.tool, key, prior + 1))
      }

      st.calls.set(key, prior + 1)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "bash") {
        const command =
          typeof input.args?.command === "string" ? input.args.command : ""
        if (!isGitMutatingBash(command)) return
        const meta = output.metadata as { exit?: number } | undefined
        if (typeof meta?.exit === "number" && meta.exit !== 0) return
        markProgress(input.sessionID)
        const clearedRepeatKeys = clearGitVerifyRepeatState(input.sessionID)
        await log("progress after git add/commit", {
          sessionID: input.sessionID,
          command: command.slice(0, 80),
          clearedRepeatKeys,
        })
        return
      }

      if (input.tool !== "write" && input.tool !== "edit") return
      const text = `${output.output ?? ""}\n${output.title ?? ""}`.trim()
      if (!text) return
      if (/no changes to apply|not found|could not find|failed to apply/i.test(text)) return

      markProgress(input.sessionID)
      await log("progress after write/edit", {
        sessionID: input.sessionID,
        tool: input.tool,
      })
    },
  }
}
