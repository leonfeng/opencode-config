import type { Plugin } from "@opencode-ai/plugin"
import {
  abortedSessions,
  clearToolBlock,
  rememberSession,
} from "./shared-session-state.ts"

const SERVICE = "stop-tool-loop-abort"

export const StopToolLoopAbortPlugin: Plugin = async ({ client }) => {
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
    event: async ({ event }) => {
      if (event.type !== "session.created" && event.type !== "session.updated") return
      const info = event.properties.info
      rememberSession(info.id, info.parentID)
    },

    "tool.execute.before": async (input) => {
      if (!abortedSessions.has(input.sessionID)) return
      await log("blocked tool after session abort", {
        sessionID: input.sessionID,
        tool: input.tool,
      })
      throw new Error(
        "This session was aborted after a blocked-tool loop. Do not retry. " +
          "vLLM only allows two concurrent generations; looping crashes the engine. " +
          "Answer from context you already have.",
      )
    },

    "tool.execute.after": async (input) => {
      if (abortedSessions.has(input.sessionID)) return
      clearToolBlock(input.sessionID)
    },
  }
}
