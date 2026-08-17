import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "stop-think-loop"
const SKIP_AGENTS = new Set(["title", "summary", "compaction"])
const SENTINEL = "Your last reply hit the output token limit while still thinking."
const RECOVERY =
  `${SENTINEL} The user saw nothing. Stop thinking. Reply now from what you already gathered. Do not rerun tools unless one specific fact is missing.`

const inFlight = new Set<string>()
const disableThinking = new Set<string>()

/** Cap output while recovering so BigBang cannot burn 16k tokens again. */
const RECOVERY_MAX_OUTPUT_TOKENS = 4096

const RECOVERY_FINISH = new Set(["tool-calls", "stop", "end_turn"])

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

function clearRecovery(sessionID: string) {
  disableThinking.delete(sessionID)
}

function stripSpentReasoning(messages: ChatMessage[]): number {
  let stripped = 0
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    const hasVisible = visibleOutput(msg.parts)
    const before = msg.parts.length
    if (msg.info.finish === "length" && !hasVisible) {
      msg.parts = msg.parts.filter((part) => part.type !== "reasoning")
    } else if (hasVisible) {
      // Reasoning alongside tools/text is hidden from the user and bloats context.
      msg.parts = msg.parts.filter((part) => part.type !== "reasoning")
    } else {
      continue
    }
    stripped += before - msg.parts.length
  }
  return stripped
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

function mergeSystemPrompts(system: string[]): string[] {
  const parts = system.map((text) => text.trim()).filter(Boolean)
  if (parts.length <= 1) return parts
  return [parts.join("\n\n")]
}

function hoistSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systems = messages.filter((msg) => msg.info.role === "system")
  if (systems.length === 0) return messages
  const rest = messages.filter((msg) => msg.info.role !== "system")
  if (systems.length === 1 && messages[0]?.info.role === "system") return messages
  const text = systems
    .map((msg) => msg.parts.map(partText).join("\n").trim())
    .filter(Boolean)
    .join("\n\n")
  return [{ ...systems[0], parts: [{ type: "text", text }] }, ...rest]
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
      if (SKIP_AGENTS.has(input.agent)) {
        applyRecoveryParams(output)
        if (input.agent === "compaction") {
          output.maxOutputTokens = 2048
        }
        await log(`${input.agent}: disabled thinking`, {
          sessionID: input.sessionID,
          maxOutputTokens: output.maxOutputTokens,
        })
        return
      }
      if (!disableThinking.has(input.sessionID)) return
      applyRecoveryParams(output)
      const cap = output.maxOutputTokens
      if (cap === undefined || cap > RECOVERY_MAX_OUTPUT_TOKENS) {
        output.maxOutputTokens = RECOVERY_MAX_OUTPUT_TOKENS
      }
      await log("disabled thinking for recovery", {
        sessionID: input.sessionID,
        agent: input.agent,
        maxOutputTokens: output.maxOutputTokens,
      })
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const before = output.system.length
      output.system = mergeSystemPrompts(output.system)
      if (output.system.length !== before) {
        await log("merged system prompts for Qwen chat template", {
          before,
          after: output.system.length,
        })
      }
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
      const messages = output.messages as ChatMessage[]
      const hoisted = hoistSystemMessages(messages)
      if (hoisted !== messages) {
        output.messages = hoisted
        await log("hoisted system messages for Qwen chat template", {
          before: messages.length,
          after: hoisted.length,
        })
      }
      const stripped = stripSpentReasoning(hoisted)
      if (stripped > 0) {
        await log("stripped spent reasoning from context", { stripped })
      }
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info as {
          role?: string
          finish?: string
          sessionID?: string
          agent?: string
        }
        const sessionID = info.sessionID
        if (
          sessionID &&
          info.role === "assistant" &&
          info.finish &&
          RECOVERY_FINISH.has(info.finish) &&
          !SKIP_AGENTS.has(info.agent ?? "")
        ) {
          clearRecovery(sessionID)
          await log("cleared recovery after assistant finish", {
            sessionID,
            finish: info.finish,
          })
        }
        return
      }

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
          clearRecovery(sessionID)
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
