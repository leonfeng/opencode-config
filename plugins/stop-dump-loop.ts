import { statSync } from "node:fs"
import { resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "stop-dump-loop"
const EXPLORE_MARKER = "Enter explore mode."
const MAX_SAME_FILE = 1
const EXPLORE_MAX_FILES = 8
const EXPLORE_MAX_BYTES = 80_000
const EXPLORE_WHOLE_FILE_BYTES = 24_576

const STOP_DUMP =
  "Dump loop: stop reading. Answer from what you already have. Use grep for a symbol; do not read whole test files or dump the repository."

type SessionState = {
  explore: boolean
  reads: Map<string, number>
  uniqueFiles: number
  bytes: number
}

export const StopDumpLoopPlugin: Plugin = async ({ client, directory }) => {
  const sessions = new Map<string, SessionState>()

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({
        body: { service: SERVICE, level: "info", message, extra },
      })
    } catch {
      // Logging must never break the session.
    }
  }

  const state = (sessionID: string): SessionState => {
    let current = sessions.get(sessionID)
    if (!current) {
      current = { explore: false, reads: new Map(), uniqueFiles: 0, bytes: 0 }
      sessions.set(sessionID, current)
    }
    return current
  }

  const resolvePath = (filePath: string): string =>
    filePath.startsWith("/") ? filePath : resolve(directory, filePath)

  const fileSize = (filePath: string): number | undefined => {
    try {
      return statSync(resolvePath(filePath)).size
    } catch {
      return undefined
    }
  }

  const isPartialRead = (args: Record<string, unknown>): boolean => {
    return args.offset != null || args.limit != null
  }

  return {
    "command.execute.before": async (input) => {
      if (!/explore/i.test(input.command)) return
      state(input.sessionID).explore = true
      await log("explore session", { sessionID: input.sessionID, command: input.command })
    },

    "chat.message": async (input, output) => {
      const text = output.parts
        .map((part) => (part.type === "text" && "text" in part ? String(part.text ?? "") : ""))
        .join("\n")
      if (text.includes(EXPLORE_MARKER)) {
        state(input.sessionID).explore = true
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "read") return
      const args = (output.args ?? {}) as Record<string, unknown>
      const filePath = String(args.filePath ?? args.path ?? "")
      if (!filePath) return

      const st = state(input.sessionID)
      const key = resolvePath(filePath)
      const partial = isPartialRead(args)
      const prior = st.reads.get(key) ?? 0
      const size = fileSize(filePath)

      if (!partial && prior >= MAX_SAME_FILE) {
        await log("blocked repeat full read", { sessionID: input.sessionID, filePath })
        throw new Error(
          `Already read ${filePath}. Re-reading it is a dump loop. ${STOP_DUMP}`,
        )
      }

      if (st.explore && !partial && size !== undefined && size > EXPLORE_WHOLE_FILE_BYTES) {
        await log("blocked large whole-file read", {
          sessionID: input.sessionID,
          filePath,
          size,
        })
        throw new Error(
          `${filePath} is ${size} bytes. During explore, do not read whole large files. Use grep, or read with offset/limit. ${STOP_DUMP}`,
        )
      }

      if (st.explore && (st.uniqueFiles >= EXPLORE_MAX_FILES || st.bytes >= EXPLORE_MAX_BYTES)) {
        await log("blocked explore dump cap", {
          sessionID: input.sessionID,
          uniqueFiles: st.uniqueFiles,
          bytes: st.bytes,
        })
        throw new Error(
          `Explore already loaded ${st.uniqueFiles} files (~${st.bytes} bytes). ${STOP_DUMP}`,
        )
      }

      if (prior === 0) st.uniqueFiles += 1
      st.reads.set(key, prior + 1)
      const added = partial
        ? Math.min(8_000, size ?? 8_000)
        : (size ?? 0)
      st.bytes += added
    },
  }
}
