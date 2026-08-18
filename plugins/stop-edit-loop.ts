import type { Plugin } from "@opencode-ai/plugin"
import { recordToolBlock } from "./shared-session-state.ts"

const SERVICE = "stop-edit-loop"

/** One try per exact edit; identical old/new is blocked immediately. */
const MAX_SAME_EDIT = 1
/** Stop hammering a file after several failed edits in a row. */
const MAX_FILE_FAILS = 3

type SessionState = {
  edits: Map<string, number>
  fileFails: Map<string, number>
}

const sessions = new Map<string, SessionState>()

function sessionState(sessionID: string): SessionState {
  let st = sessions.get(sessionID)
  if (!st) {
    st = { edits: new Map(), fileFails: new Map() }
    sessions.set(sessionID, st)
  }
  return st
}

function editKey(filePath: string, oldString: string, newString: string): string {
  return `${filePath}\0${oldString}\0${newString}`
}

function loopMessage(kind: "identical" | "repeat" | "file", filePath: string, count?: number): string {
  if (kind === "identical") {
    return (
      `edit loop: oldString and newString are identical for ${filePath}. ` +
      "The change is already applied — mark the OpenSpec task done and move on. " +
      "Do not retry this edit."
    )
  }
  if (kind === "file") {
    return (
      `edit loop: ${count} failed edit(s) on ${filePath} this session. ` +
      "Stop retrying — the file may already be correct. Mark the task done, run one targeted test, or explain what is still broken."
    )
  }
  return (
    `edit loop: this exact edit on ${filePath} already ran once. ` +
    "Do not repeat it — use the prior error, read a different section, or mark the task done."
  )
}

export const StopEditLoopPlugin: Plugin = async ({ client }) => {
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
      if (input.tool !== "edit") return
      const args = (output.args ?? {}) as Record<string, unknown>
      const filePath = String(args.filePath ?? args.path ?? "")
      const oldString = String(args.oldString ?? args.old_string ?? "")
      const newString = String(args.newString ?? args.new_string ?? "")
      if (!filePath || !oldString) return

      const st = sessionState(input.sessionID)

      if (oldString === newString) {
        const n = (st.fileFails.get(filePath) ?? 0) + 1
        st.fileFails.set(filePath, n)
        await recordToolBlock(client, input.sessionID, "edit-identical")
        await log("blocked identical edit", { sessionID: input.sessionID, filePath, fileFails: n })
        throw new Error(loopMessage("identical", filePath))
      }

      const fileFails = st.fileFails.get(filePath) ?? 0
      if (fileFails >= MAX_FILE_FAILS) {
        await recordToolBlock(client, input.sessionID, "edit-file-fail")
        await log("blocked edit after file failures", {
          sessionID: input.sessionID,
          filePath,
          fileFails,
        })
        throw new Error(loopMessage("file", filePath, fileFails))
      }

      const key = editKey(filePath, oldString, newString)
      const prior = st.edits.get(key) ?? 0
      if (prior >= MAX_SAME_EDIT) {
        const n = fileFails + 1
        st.fileFails.set(filePath, n)
        await recordToolBlock(client, input.sessionID, "edit-repeat")
        await log("blocked repeat edit", {
          sessionID: input.sessionID,
          filePath,
          count: prior + 1,
          fileFails: n,
        })
        throw new Error(loopMessage("repeat", filePath))
      }

      st.edits.set(key, prior + 1)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "edit") return
      const args = input.args ?? {}
      const filePath = String(args.filePath ?? args.path ?? "")
      if (!filePath) return

      const text = `${output.output ?? ""}\n${output.title ?? ""}`.trim()
      const st = sessionState(input.sessionID)

      if (text && !/no changes to apply|oldstring.*not found|could not find|failed to apply/i.test(text)) {
        st.fileFails.set(filePath, 0)
        return
      }

      const n = (st.fileFails.get(filePath) ?? 0) + 1
      st.fileFails.set(filePath, n)
      await log("recorded failed edit", { sessionID: input.sessionID, filePath, n })
    },
  }
}
