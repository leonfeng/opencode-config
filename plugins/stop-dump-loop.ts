import { statSync } from "node:fs"
import { resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "stop-dump-loop"
const EXPLORE_MARKER = "Enter explore mode."
const MAX_SAME_FILE = 1
const EXPLORE_MAX_FILES = 8
const EXPLORE_MAX_BYTES = 80_000
const EXPLORE_WHOLE_FILE_BYTES = 24_576
/** Build/apply: allow more than explore, but stop template/test dumps. */
const BUILD_MAX_FILES = 18
const BUILD_MAX_BYTES = 100_000
const BUILD_MAX_PARTIAL_READS = 3

const STOP_DUMP =
  "Dump loop: stop reading. Answer from what you already have. Use grep for a symbol; do not read whole test files or dump the repository."

type SessionState = {
  explore: boolean
  reads: Map<string, number>
  partialReads: Map<string, number>
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
      current = { explore: false, reads: new Map(), partialReads: new Map(), uniqueFiles: 0, bytes: 0 }
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
      const partialPrior = st.partialReads.get(key) ?? 0
      const size = fileSize(filePath)

      if (!partial && prior >= MAX_SAME_FILE) {
        await log("blocked repeat full read", { sessionID: input.sessionID, filePath })
        throw new Error(
          `Already read ${filePath}. Re-reading it is a dump loop. ${STOP_DUMP}`,
        )
      }

      if (partial && partialPrior >= BUILD_MAX_PARTIAL_READS) {
        await log("blocked repeat partial read", {
          sessionID: input.sessionID,
          filePath,
          partialReads: partialPrior,
        })
        throw new Error(
          `Already read sections of ${filePath} ${partialPrior} times. ${STOP_DUMP}`,
        )
      }

      const maxFiles = st.explore ? EXPLORE_MAX_FILES : BUILD_MAX_FILES
      const maxBytes = st.explore ? EXPLORE_MAX_BYTES : BUILD_MAX_BYTES

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

      if (st.uniqueFiles >= maxFiles || st.bytes >= maxBytes) {
        await log("blocked dump cap", {
          sessionID: input.sessionID,
          explore: st.explore,
          uniqueFiles: st.uniqueFiles,
          bytes: st.bytes,
          maxFiles,
          maxBytes,
        })
        throw new Error(
          `${st.explore ? "Explore" : "Build"} already loaded ${st.uniqueFiles} files (~${st.bytes} bytes). ${STOP_DUMP}`,
        )
      }

      if (prior === 0 && partialPrior === 0) st.uniqueFiles += 1
      st.reads.set(key, prior + (partial ? 0 : 1))
      if (partial) st.partialReads.set(key, partialPrior + 1)
      const added = partial
        ? Math.min(8_000, size ?? 8_000)
        : (size ?? 0)
      st.bytes += added
    },
  }
}
