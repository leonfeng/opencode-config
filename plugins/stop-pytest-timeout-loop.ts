import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "stop-pytest-timeout-loop"
const CONFIRM_RE = /#\s*confirm\s*$/i
const BYPASS = 'To run this in bash anyway, append `# confirm`.'

/** OpenCode default is 120s; snekdo full suite (incl. e2e) can exceed that. */
const PYTEST_BASH_TIMEOUT_MS = 600_000

const BASH_TIMEOUT_RE =
  /bash tool terminated command after exceeding timeout (\d+) ms/i

type SessionState = {
  /** Normalized full-suite pytest commands killed by OpenCode bash timeout. */
  timedOutFullSuite: Set<string>
  timeoutHints: number
}

const sessions = new Map<string, SessionState>()

function sessionState(sessionID: string): SessionState {
  let st = sessions.get(sessionID)
  if (!st) {
    st = { timedOutFullSuite: new Set(), timeoutHints: 0 }
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

function isPytestStatement(statement: string): boolean {
  const s = stripEnvPrefix(statement)
  return /^(?:\S+\/)?(?:python3?\s+-m\s+)?pytest(?:\s|$)/.test(s)
}

/** pytest has no top-level `--timeout` CLI flag (only pytest-timeout plugin: `--timeout=SECS`). */
function hasHallucinatedPytestTimeout(statement: string): boolean {
  const s = stripEnvPrefix(statement)
  if (!isPytestStatement(s)) return false
  return /\s--timeout(?:=\S*|\s+\S+|\s*$)/.test(s)
}

function pytestArgs(statement: string): string {
  const s = stripEnvPrefix(statement)
  const m = s.match(/^(?:\S+\/)?(?:python3?\s+-m\s+)?pytest(?:\s+(.*))?$/i)
  return (m?.[1] ?? "").trim()
}

/** Whole suite: bare `pytest`, `pytest -v`, `pytest tests/`, no `.py` or `::` target. */
function isFullPytestSuite(statement: string): boolean {
  if (!isPytestStatement(statement)) return false
  const args = pytestArgs(statement)
  if (!args) return true
  if (/\.py(?:::|\s|$)/.test(args)) return false
  if (/::/.test(args)) return false
  const positional = ` ${args}`
    .replace(/\s+-[\w-]+(?:=\S+|\s+\S+)?/g, " ")
    .replace(/\s+-[\w-]+\b/g, " ")
    .trim()
  if (!positional) return true
  if (/^tests\/?(\s|$)/.test(positional)) return true
  return false
}

function normalizeFullSuiteKey(statement: string): string {
  return stripEnvPrefix(statement)
    .replace(/\s+/g, " ")
    .replace(/\s2>&1\s*$/, "")
    .trim()
    .toLowerCase()
}

function pytestTimeoutHint(ms: number, command: string): string {
  const full = isFullPytestSuite(command)
  return [
    "OpenCode bash timeout (not pytest): the shell was SIGTERM'd before pytest finished.",
    `Killed after ${ms} ms. pytest has no \`--timeout\` CLI flag — do not add it.`,
    full
      ? "Do not rerun the full suite. Use prior partial output, run `-m 'not e2e'` for unit tests, or target one file/node."
      : "Retry only if you need a specific missing fact; prefer a narrower pytest target.",
    "Long runs: the bash tool accepts a `timeout` parameter in milliseconds (already raised for pytest here).",
  ].join(" ")
}

export const StopPytestTimeoutLoopPlugin: Plugin = async ({ client }) => {
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

      let needsLongTimeout = false

      for (const statement of splitStatements(command)) {
        if (!isPytestStatement(statement)) continue
        needsLongTimeout = true

        if (hasHallucinatedPytestTimeout(statement)) {
          await log("blocked invalid pytest --timeout", {
            sessionID: input.sessionID,
            statement,
          })
          throw new Error(
            "pytest has no `--timeout` flag. OpenCode killed the previous shell (bash tool timeout), not pytest. " +
              "Do not rerun the full suite with invented flags. Use `-m 'not e2e'`, a single test file, or read the partial output you already have. " +
              BYPASS,
          )
        }

        if (isFullPytestSuite(statement)) {
          const key = normalizeFullSuiteKey(statement)
          const st = sessionState(input.sessionID)
          if (st.timedOutFullSuite.has(key)) {
            await log("blocked repeat full-suite pytest after bash timeout", {
              sessionID: input.sessionID,
              key,
            })
            throw new Error(
              "Full pytest suite already hit an OpenCode bash timeout this session. " +
                "Do not run it again — use partial output from the killed run, `-m 'not e2e'`, or one file/node. " +
                BYPASS,
            )
          }
        }
      }

      if (!needsLongTimeout) return

      const current =
        typeof output.args?.timeout === "number" && Number.isFinite(output.args.timeout)
          ? output.args.timeout
          : 0
      if (current < PYTEST_BASH_TIMEOUT_MS) {
        output.args.timeout = PYTEST_BASH_TIMEOUT_MS
        await log("raised bash timeout for pytest", {
          sessionID: input.sessionID,
          from: current || "default",
          to: PYTEST_BASH_TIMEOUT_MS,
        })
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const command = typeof input.args?.command === "string" ? input.args.command : ""
      if (!command.trim()) return

      const text = `${output.output ?? ""}`
      const match = BASH_TIMEOUT_RE.exec(text)
      if (!match) return

      const killedMs = Number(match[1])
      const st = sessionState(input.sessionID)
      st.timeoutHints += 1

      for (const statement of splitStatements(command)) {
        if (!isPytestStatement(statement)) continue
        if (isFullPytestSuite(statement)) {
          st.timedOutFullSuite.add(normalizeFullSuiteKey(statement))
        }
        output.output = `${text}\n\n${pytestTimeoutHint(killedMs, statement)}`
        await log("annotated pytest bash timeout", {
          sessionID: input.sessionID,
          killedMs,
          fullSuite: isFullPytestSuite(statement),
          hints: st.timeoutHints,
        })
        return
      }
    },
  }
}
