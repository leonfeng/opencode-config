import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "propose-ask-first"
const CONFIRM_RE = /#\s*confirm\s*$/i
const PROPOSE_CMD = /(?:^|[/\s:-])(?:opsx[-:]?)?propose$/i
const PROPOSE_BODY =
  "Propose a new change - create the change and generate all artifacts in one step."
const ASK =
  'What change do you want to work on? Describe what you want to build or fix.'
const SYSTEM_HINT =
  `CRITICAL: /opsx-propose was invoked with no change name or description. ` +
  `Your only allowed action is to ask the user (open-ended, no tools): "${ASK}" ` +
  `Do not read, glob, grep, bash, openspec, explore, or invent a change. ` +
  `Wait for their reply.`

/** Sessions waiting for a user description after empty /opsx-propose. */
export const proposeAwaitingDescription = new Set<string>()

const ALLOWED_WHILE_AWAITING = new Set(["question"])

function isProposeCommand(command: string): boolean {
  const base = command.trim().split(/\s+/)[0] ?? ""
  return PROPOSE_CMD.test(base) || /propose/i.test(base)
}

function isProposeWorkflowBody(text: string): boolean {
  return text.includes(PROPOSE_BODY)
}

function pathHasConfirm(args: Record<string, unknown>): boolean {
  for (const key of ["filePath", "path", "pattern", "glob_pattern", "command"]) {
    const v = args[key]
    if (typeof v === "string" && CONFIRM_RE.test(v)) return true
  }
  return false
}

export const ProposeAskFirstPlugin: Plugin = async ({ client }) => {
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
    "command.execute.before": async (input) => {
      if (!isProposeCommand(input.command)) return
      const args = (input.arguments ?? "").trim()
      if (args) {
        proposeAwaitingDescription.delete(input.sessionID)
        return
      }
      proposeAwaitingDescription.add(input.sessionID)
      await log("awaiting description", {
        sessionID: input.sessionID,
        command: input.command,
      })
    },

    "chat.message": async (input, output) => {
      if (!proposeAwaitingDescription.has(input.sessionID)) return
      const text = output.parts
        .map((part) =>
          part.type === "text" && "text" in part ? String(part.text ?? "") : "",
        )
        .join("\n")
        .trim()
      if (!text || isProposeWorkflowBody(text)) return
      proposeAwaitingDescription.delete(input.sessionID)
      await log("description received", {
        sessionID: input.sessionID,
        chars: text.length,
      })
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || !proposeAwaitingDescription.has(input.sessionID)) return
      output.system.push(SYSTEM_HINT)
    },

    "tool.execute.before": async (input, output) => {
      if (!proposeAwaitingDescription.has(input.sessionID)) return
      if (ALLOWED_WHILE_AWAITING.has(input.tool)) return
      const args = (output.args ?? {}) as Record<string, unknown>
      if (pathHasConfirm(args)) return
      if (input.tool === "bash" && CONFIRM_RE.test(String(args.command ?? ""))) return

      await log("blocked tool before description", {
        sessionID: input.sessionID,
        tool: input.tool,
      })
      throw new Error(
        `Empty /opsx-propose: ask the user first — "${ASK}" ` +
          `Do not ${input.tool} until they describe the change. ` +
          `To override, append \`# confirm\` to the path or command.`,
      )
    },
  }
}
