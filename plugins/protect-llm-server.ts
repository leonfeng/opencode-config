import type { Plugin } from "@opencode-ai/plugin"
import { recordToolBlock } from "./shared-session-state.ts"

const SERVICE = "protect-llm-server"
const CONFIRM_RE = /#\s*confirm\s*$/i
const BYPASS = 'To run this in bash anyway, append `# confirm`.'

/** Local LLM API ports (vLLM / SparkRun). Never kill these from agent bash. */
const PROTECTED_PORTS = [8000, 8888] as const

/** E2E / test servers — kill by port is allowed. */
const ALLOWED_PORTS = [8765] as const

/**
 * Process patterns that match the LLM stack, or are too broad and can hit
 * the agent's own shell / vLLM / OpenCode (e.g. `pkill -f uvicorn`).
 */
const BLOCKED_PROCESS_RES: { re: RegExp; label: string }[] = [
  { re: /\buvicorn\b/i, label: "uvicorn" },
  { re: /\bvllm\b/i, label: "vllm" },
  { re: /\bEngineCore\b/, label: "EngineCore" },
  { re: /\bAPIServer\b/, label: "APIServer" },
  { re: /\bserve-nemotron\b/i, label: "serve-nemotron" },
  { re: /\bsparkrun\b/i, label: "sparkrun" },
  { re: /\bsnekdo\b/i, label: "snekdo (too broad — kill e2e by port 8765 only)" },
]

function isKillish(command: string): boolean {
  return (
    /\b(?:pkill|killall|kill)\b/i.test(command) ||
    /\bfuser\b[^;\n]*-k\b/i.test(command) ||
    /\blsof\b[^;\n]*-t\b/i.test(command)
  )
}

function mentionsPort(command: string, port: number): boolean {
  // -i:8000, -i 8000, :8000, 8000/tcp, PORT=8000 in kill contexts
  const re = new RegExp(
    `(?:-i:?\\s*|:)(${port})(?:\\b|/)|(?:^|\\s)${port}/tcp\\b|\\b${port}\\b(?=\\s*\\)|$)`,
    "i",
  )
  return re.test(command) || new RegExp(`\\blsof\\b[^\\n]*\\b${port}\\b`, "i").test(command)
}

function protectedPortHit(command: string): number | null {
  for (const port of PROTECTED_PORTS) {
    if (mentionsPort(command, port)) return port
  }
  return null
}

function onlyAllowedPorts(command: string): boolean {
  const hitProtected = PROTECTED_PORTS.some((p) => mentionsPort(command, p))
  if (hitProtected) return false
  return ALLOWED_PORTS.some((p) => mentionsPort(command, p))
}

function blockedProcessLabel(command: string): string | null {
  if (!/\b(?:pkill|killall)\b/i.test(command)) return null
  for (const { re, label } of BLOCKED_PROCESS_RES) {
    if (re.test(command)) return label
  }
  return null
}

/** Exported for quick local checks. */
export function protectLlmReason(command: string): string | null {
  if (!command.trim() || CONFIRM_RE.test(command)) return null
  if (!isKillish(command)) return null

  // Pure e2e port cleanup is fine (e.g. kill $(lsof -t -i:8765)).
  if (onlyAllowedPorts(command) && !blockedProcessLabel(command)) return null

  const port = protectedPortHit(command)
  if (port !== null) {
    return (
      `Blocked: killing processes on port ${port} would stop the local LLM API ` +
      `(OpenCode → :8000, SparkRun → :8888). For e2e, kill only port 8765 ` +
      `(e.g. \`kill $(lsof -t -i:8765)\` or \`fuser -k 8765/tcp\`). ` +
      "Do not pkill uvicorn/snekdo/vllm. " +
      BYPASS
    )
  }

  const label = blockedProcessLabel(command)
  if (label) {
    return (
      `Blocked: \`pkill\`/\`killall\` matching ${label} can kill the LLM server ` +
      "or the agent's own shell (and look like an OpenCode crash). " +
      "For e2e cleanup use port 8765 only. Leave :8000/:8888 alone. " +
      BYPASS
    )
  }

  return null
}

export const ProtectLlmServerPlugin: Plugin = async ({ client }) => {
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
      const reason = protectLlmReason(command)
      if (!reason) return

      await recordToolBlock(client, input.sessionID, "protect-llm-server")
      await log("blocked kill targeting LLM server", {
        sessionID: input.sessionID,
        command: command.slice(0, 200),
      })
      throw new Error(reason)
    },
  }
}
