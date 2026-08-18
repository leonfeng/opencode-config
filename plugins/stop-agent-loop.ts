import type { Plugin } from "@opencode-ai/plugin"
import {
  isChildSession,
  recordToolBlock,
} from "./shared-session-state.ts"

const SERVICE = "stop-agent-loop"
const CONFIRM_RE = /#\s*confirm\s*$/i

/** Block the 3rd identical tool call (git diff, read, edit, grep, …). */
const MAX_SAME_CALL = 2
/** Primary apply: reads/greps before first edit can take a while. */
const MAX_NO_PROGRESS_PRIMARY = 20
/** Child @explore/@general: answer sooner. */
const MAX_NO_PROGRESS_CHILD = 12

type SessionState = {
  calls: Map<string, number>
  stepsSinceProgress: number
}

const sessions = new Map<string, SessionState>()

function state(sessionID: string): SessionState {
  let st = sessions.get(sessionID)
  if (!st) {
    st = { calls: new Map(), stepsSinceProgress: 0 }
    sessions.set(sessionID, st)
  }
  return st
}

function markProgress(sessionID: string) {
  state(sessionID).stepsSinceProgress = 0
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

function repeatMessage(tool: string, key: string, count: number): string {
  const hint =
    tool === "bash" && key.includes("git-diff")
      ? "The diff is already in context. Edit the file, mark the OpenSpec task done, or say what is still wrong."
      : "Use the prior output. Edit code, mark the task done, or explain the blocker — do not rerun this call."

  return (
    `Agent loop: the same ${tool} call already ran ${count} time(s) this session. ${hint} ` +
    "Append `# confirm` to run anyway."
  )
}

function noProgressMessage(steps: number, child: boolean): string {
  return (
    `Agent loop: ${steps} tool calls since your last successful write/edit. ` +
    (child
      ? "Close out with findings — do not keep exploring."
      : "Stop verifying (git diff, pytest, re-reads). Edit openspec tasks.md, change code, or summarize what's blocked.") +
    " Append `# confirm` to continue anyway."
  )
}

function isConfirmBypass(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "bash") {
    return CONFIRM_RE.test(String(args.command ?? ""))
  }
  return false
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
    "tool.execute.before": async (input, output) => {
      const args = (output.args ?? {}) as Record<string, unknown>
      if (isConfirmBypass(input.tool, args)) return

      const st = state(input.sessionID)
      const child = isChildSession(input.sessionID)
      const maxNoProgress = child ? MAX_NO_PROGRESS_CHILD : MAX_NO_PROGRESS_PRIMARY

      st.stepsSinceProgress += 1
      if (st.stepsSinceProgress > maxNoProgress) {
        await recordToolBlock(client, input.sessionID, "no-progress")
        await log("blocked no-progress loop", {
          sessionID: input.sessionID,
          steps: st.stepsSinceProgress,
          child,
        })
        throw new Error(noProgressMessage(st.stepsSinceProgress, child))
      }

      const key = callKey(input.tool, args)
      const prior = st.calls.get(key) ?? 0
      if (prior >= MAX_SAME_CALL) {
        await recordToolBlock(client, input.sessionID, `repeat:${input.tool}`)
        await log("blocked repeat tool call", {
          sessionID: input.sessionID,
          tool: input.tool,
          key,
          count: prior + 1,
        })
        throw new Error(repeatMessage(input.tool, key, prior + 1))
      }

      st.calls.set(key, prior + 1)
    },

    "tool.execute.after": async (input, output) => {
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
