import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "stop-python-c-loop"
const CONFIRM_RE = /#\s*confirm\s*$/i
const BYPASS = 'To run this in bash anyway, append `# confirm`.'

/** Block the same inline script twice; cap debug families at three tries. */
const MAX_SAME_SCRIPT = 1
const MAX_FAMILY = 3

type SessionState = {
  scripts: Map<string, number>
  families: Map<string, number>
}

const sessions = new Map<string, SessionState>()

function sessionState(sessionID: string): SessionState {
  let st = sessions.get(sessionID)
  if (!st) {
    st = { scripts: new Map(), families: new Map() }
    sessions.set(sessionID, st)
  }
  return st
}

function splitStatements(command: string): string[] {
  const out: string[] = []
  let buf = ""
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const prev = command[i - 1]
    if (quote) {
      buf += c
      if (c === quote && prev !== "\\") quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      buf += c
      continue
    }
    if (c === "#" && (buf === "" || /\s$/.test(buf))) break
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      i++
      continue
    }
    if (c === ";" || c === "\n") {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function stripEnvPrefix(statement: string): string {
  return statement.trim().replace(/^(\w+=\S+\s+)+/, "").trim()
}

function stripRunnerPrefix(statement: string): string {
  return stripEnvPrefix(statement).replace(/^uv\s+run\s+/, "").trim()
}

function extractPythonCBody(statement: string): string | null {
  const s = stripRunnerPrefix(statement)
  const match = /^(?:\S+\/)?(?:python3?\s+-c\s+)([\s\S]+)$/i.exec(s)
  if (!match) return null
  let body = match[1].trim()
  const quote = body[0]
  if ((quote === '"' || quote === "'") && body.endsWith(quote)) {
    body = body.slice(1, -1)
  }
  return body
}

function normalizeScript(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 400).toLowerCase()
}

function scriptFamily(body: string): string | null {
  const lower = body.toLowerCase()
  if (lower.includes("testclient")) return "testclient"
  if (lower.includes("uvicorn")) return "uvicorn-debug"
  if (lower.includes("inspect.getsource")) return "inspect-source"
  if (/\bplaywright\b/.test(lower)) return "playwright-inline"
  return null
}

function loopMessage(kind: "script" | "family", count: number, family?: string): string {
  if (kind === "script") {
    return (
      `python -c loop: the same inline debug script already ran ${count} time(s) this session. ` +
      "Stop rerunning it — use the prior output, run pytest on one file/node, or edit the code. " +
      BYPASS
    )
  }
  return (
    `python -c loop: ${count} inline ${family} debug scripts already ran this session. ` +
    "Stop inventing new variants — fix the code or run one targeted pytest. " +
    BYPASS
  )
}

export const StopPythonCLoopPlugin: Plugin = async ({ client }) => {
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
      if (!command.trim() || CONFIRM_RE.test(command)) return

      const st = sessionState(input.sessionID)

      for (const statement of splitStatements(command)) {
        const body = extractPythonCBody(statement)
        if (!body) continue

        const key = normalizeScript(body)
        const prior = st.scripts.get(key) ?? 0
        if (prior >= MAX_SAME_SCRIPT) {
          await log("blocked repeat python -c script", {
            sessionID: input.sessionID,
            count: prior + 1,
            key: key.slice(0, 80),
          })
          throw new Error(loopMessage("script", prior + 1))
        }

        const family = scriptFamily(body)
        if (family) {
          const famCount = st.families.get(family) ?? 0
          if (famCount >= MAX_FAMILY) {
            await log("blocked python -c family loop", {
              sessionID: input.sessionID,
              family,
              count: famCount + 1,
            })
            throw new Error(loopMessage("family", famCount + 1, family))
          }
          st.families.set(family, famCount + 1)
        }

        st.scripts.set(key, prior + 1)
      }
    },
  }
}
