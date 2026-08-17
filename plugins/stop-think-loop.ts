import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "stop-think-loop"
const SKIP_AGENTS = new Set(["title", "summary", "compaction"])
const SENTINEL = "Your last reply hit the output token limit while still thinking."
const RECOVERY =
  `${SENTINEL} The user saw nothing. Stop thinking. Reply now from what you already gathered. Do not rerun tools unless one specific fact is missing.`

const inFlight = new Set<string>()
const disableThinking = new Set<string>()

type ChatMessage = {
  info: { id?: string; role: string; finish?: string; sessionID?: string }
  parts: Array<{ type?: string; text?: string }>
}

function partText(part: { type?: string; text?: string }): string {
  return part.type === "text" && typeof part.text === "string" ? part.text : ""
}

function visibleOutput(parts: Array<{ type?: string; text?: string }>): boolean {
  return parts.some((part) => partText(part).trim() !== "" || part.type === "tool")
}

function lastUserHasSentinel(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role !== "user") continue
    return messages[i].parts.some((part) => partText(part).includes(SENTINEL))
  }
  return false
}

function applyRecoveryParams(output: { options: Record<string, any> }) {
  // Variant high/medium sets reasoningEffort, which vLLM turns into
  // enable_thinking: true unless chat_template_kwargs wins.
  delete output.options.reasoningEffort
  const prev =
    output.options.chat_template_kwargs &&
    typeof output.options.chat_template_kwargs === "object" &&
    !Array.isArray(output.options.chat_template_kwargs)
      ? output.options.chat_template_kwargs
      : {}
  output.options.chat_template_kwargs = {
    ...prev,
    enable_thinking: false,
    preserve_thinking: true,
  }
}

export const StopThinkLoopPlugin: Plugin = async ({ client }) => {
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
    "chat.message": async (input, output) => {
      if (output.parts.some((part) => partText(part).includes(SENTINEL))) {
        disableThinking.add(input.sessionID)
      } else if (input.sessionID) {
        disableThinking.delete(input.sessionID)
      }
    },

    "chat.params": async (input, output) => {
      if (input.agent === "compaction") {
        applyRecoveryParams(output)
        output.maxOutputTokens = 2048
        await log("compaction: disabled thinking, capped output", {
          sessionID: input.sessionID,
        })
        return
      }
      if (SKIP_AGENTS.has(input.agent)) return
      if (!disableThinking.has(input.sessionID)) return
      applyRecoveryParams(output)
      await log("disabled thinking for recovery", {
        sessionID: input.sessionID,
        agent: input.agent,
      })
    },

    "experimental.session.compacting": async (_input, output) => {
      output.prompt = [
        "Write a short continuation summary. Do not copy file contents, tool output, or code.",
        "At most 20 bullets: goal, files touched, findings, what is still open.",
        "Then stop. The next turn will continue from this summary.",
      ].join(" ")
    },

    "experimental.compaction.autocontinue": async (input, output) => {
      if (!input.overflow) return
      output.enabled = false
      await log("disabled autocontinue after overflow compaction", {
        sessionID: input.sessionID,
      })
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      let stripped = 0
      for (const msg of output.messages as ChatMessage[]) {
        if (msg.info.role !== "assistant") continue
        if (msg.info.finish !== "length") continue
        if (visibleOutput(msg.parts)) continue
        const before = msg.parts.length
        msg.parts = msg.parts.filter((part) => part.type !== "reasoning")
        stripped += before - msg.parts.length
      }
      if (stripped > 0) {
        await log("stripped stalled reasoning from context", { stripped })
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (!sessionID || inFlight.has(sessionID)) return
      inFlight.add(sessionID)

      try {
        const result = await client.session.messages({
          path: { id: sessionID },
        })
        const messages = (
          Array.isArray(result) ? result : Array.isArray(result.data) ? result.data : []
        ) as ChatMessage[]
        if (messages.length === 0) return

        const last = messages[messages.length - 1]
        const info = last.info
        if (info.role !== "assistant") return
        if (visibleOutput(last.parts)) {
          disableThinking.delete(sessionID)
          return
        }
        if (info.finish !== "length") return
        if (SKIP_AGENTS.has((info as { agent?: string }).agent ?? "")) return
        if (lastUserHasSentinel(messages)) return

        disableThinking.add(sessionID)
        await log("recovering think-length stall", {
          sessionID,
          messageID: info.id,
          outputTokens: (info as { tokens?: { output?: number } }).tokens?.output,
        })
        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: RECOVERY }],
          },
        })
      } catch (error) {
        await log("think-length recovery failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        inFlight.delete(sessionID)
      }
    },
  }
}
