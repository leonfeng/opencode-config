import type { Plugin } from "@opencode-ai/plugin"

const SERVICE = "playwright-python-api"

const PAGE_DOCS = "https://playwright.dev/python/docs/api/class-page"
const SKILL = "playwright-python"

/** JS Playwright identifiers → Python. Overrides win over camelCase→snake_case. */
const JS_TO_PY: Record<string, string> = {
  waitForTimeout: "wait_for_timeout",
  waitForLoadState: "wait_for_load_state",
  waitForURL: "wait_for_url",
  waitForSelector: "locator(...).wait_for()",
  waitForFunction: "wait_for_function",
  waitForEvent: "wait_for_event",
  waitForResponse: "async with page.expect_response(...)  (not waitForResponse)",
  waitForRequest: "async with page.expect_request(...)",
  waitForNavigation: "wait_for_url or async with page.expect_navigation()",
  waitForClose: "wait_for_event('close')",
  getByRole: "get_by_role",
  getByText: "get_by_text",
  getByLabel: "get_by_label",
  getByPlaceholder: "get_by_placeholder",
  getByTestId: "get_by_test_id",
  getByAltText: "get_by_alt_text",
  getByTitle: "get_by_title",
  innerText: "inner_text",
  innerHTML: "inner_html",
  textContent: "text_content",
  inputValue: "input_value",
  getAttribute: "get_attribute",
  setInputFiles: "set_input_files",
  selectOption: "select_option",
  isVisible: "is_visible",
  isHidden: "is_hidden",
  isEnabled: "is_enabled",
  isDisabled: "is_disabled",
  isEditable: "is_editable",
  isChecked: "is_checked",
  waitFor: "wait_for",
  goBack: "go_back",
  goForward: "go_forward",
  setContent: "set_content",
  setViewportSize: "set_viewport_size",
  setDefaultTimeout: "set_default_timeout",
  addInitScript: "add_init_script",
}

const JS_NAMES = Object.keys(JS_TO_PY)
const JS_CALL_RE = new RegExp(`\\.(${JS_NAMES.join("|")})\\s*\\(`, "g")
const EXPECT_WITH_RE =
  /(?:^|[\s;])(async\s+)?with\s+\w+\.expect_(?:response|request|navigation|download|popup|file_chooser|console_message|page)\s*\(/g
const ATTR_ERR_RE =
  /'(?:Page|Locator|Browser|BrowserContext|ElementHandle)' object has no attribute '([^']+)'/g
const DID_YOU_MEAN_RE = /Did you mean: '([^']+)'/
const ASYNC_CM_RE = /AsyncEventContextManager' object does not support the context manager protocol/

function pythonPath(filePath: string | undefined): boolean {
  return typeof filePath === "string" && filePath.endsWith(".py")
}

function jsHitsIn(text: string): string[] {
  const found = new Set<string>()
  JS_CALL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = JS_CALL_RE.exec(text))) {
    found.add(match[1])
  }
  return [...found]
}

function mappingLines(names: string[]): string {
  return names.map((js) => `  ${js} → ${JS_TO_PY[js] ?? toSnake(js)}`).join("\n")
}

function toSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function looksCamelCase(name: string): boolean {
  return /[a-z][A-Z]/.test(name)
}

function hint(detail: string): string {
  return [
    "",
    "PLAYWRIGHT PYTHON: that is the JavaScript API. Python is snake_case.",
    detail,
    `Load skill \`${SKILL}\` or webfetch ${PAGE_DOCS} before writing more Playwright code.`,
    "Do not guess another camelCase method. Do not rerun pytest until the names are snake_case.",
    `async with page.expect_response(...):  — not \`with page.expect_response\` and not waitForResponse.`,
  ].join("\n")
}

function blockMessage(names: string[], extra?: string): string {
  const lines = [
    "JavaScript Playwright APIs are not valid in Python.",
    mappingLines(names),
    extra,
    `Load skill \`${SKILL}\` or webfetch ${PAGE_DOCS}. Use snake_case (wait_for_timeout, get_by_role).`,
  ].filter(Boolean)
  return lines.join("\n")
}

function hasSyncExpect(text: string): boolean {
  EXPECT_WITH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EXPECT_WITH_RE.exec(text))) {
    if (!match[1]) return true
  }
  return false
}

function scanSource(text: string): { names: string[]; syncExpect: boolean } {
  return {
    names: jsHitsIn(text),
    syncExpect: hasSyncExpect(text),
  }
}

function addedPatchLines(patchText: string): string {
  return patchText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")
}

function patchTouchesPython(patchText: string): boolean {
  return /^(?:\*\*\* (?:Add|Update) File:|\+\+\+ [ab]\/).*\.py\s*$/m.test(patchText)
}

type SessionState = { jsApiErrors: number }

export const PlaywrightPythonApiPlugin: Plugin = async ({ client }) => {
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
      current = { jsApiErrors: 0 }
      sessions.set(sessionID, current)
    }
    return current
  }

  return {
    "tool.definition": async (input, output) => {
      if (input.toolID === "webfetch") {
        output.description += ` For Playwright Python tests, fetch ${PAGE_DOCS} before writing code (snake_case API, not JavaScript).`
      }
      if (input.toolID === "skill") {
        output.description += ` For Playwright Python / pytest e2e tests, load \`${SKILL}\` before writing code.`
      }
    },

    "tool.execute.before": async (input, output) => {
      const args = output.args ?? {}

      if (input.tool === "write" || input.tool === "edit") {
        const filePath = typeof args.filePath === "string" ? args.filePath : args.path
        if (!pythonPath(filePath)) return
        const text =
          input.tool === "write"
            ? String(args.content ?? "")
            : String(args.newString ?? args.new_string ?? "")
        const { names, syncExpect } = scanSource(text)
        if (names.length === 0 && !syncExpect) return
        await log("blocked js playwright api in python", {
          sessionID: input.sessionID,
          filePath,
          names,
          syncExpect,
        })
        throw new Error(
          blockMessage(
            names,
            syncExpect
              ? "Use `async with page.expect_response(...)`, not sync `with page.expect_response(...)`."
              : undefined,
          ),
        )
      }

      if (input.tool === "apply_patch") {
        const patchText = String(args.patchText ?? args.patch ?? "")
        if (!patchText || !patchTouchesPython(patchText)) return
        const { names, syncExpect } = scanSource(addedPatchLines(patchText))
        if (names.length === 0 && !syncExpect) return
        await log("blocked js playwright api in patch", {
          sessionID: input.sessionID,
          names,
          syncExpect,
        })
        throw new Error(
          blockMessage(
            names,
            syncExpect
              ? "Use `async with page.expect_response(...)`, not sync `with page.expect_response(...)`."
              : undefined,
          ),
        )
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const text = `${output.output ?? ""}\n${typeof output.metadata === "string" ? output.metadata : ""}`
      const jsAttrs: string[] = []
      ATTR_ERR_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = ATTR_ERR_RE.exec(text))) {
        const attr = match[1]
        if (looksCamelCase(attr) || JS_TO_PY[attr]) jsAttrs.push(attr)
      }
      const didYouMean = DID_YOU_MEAN_RE.exec(text)?.[1]
      const playwrightDidYouMean = Boolean(
        didYouMean && /^(wait_for_|get_by_|is_|inner_|text_|set_input_|select_)/.test(didYouMean),
      )
      const asyncCm = ASYNC_CM_RE.test(text)
      if (jsAttrs.length === 0 && !asyncCm && !playwrightDidYouMean) return

      const st = state(input.sessionID)
      st.jsApiErrors += 1
      const unique = [...new Set(jsAttrs)]
      const detailParts: string[] = []
      if (unique.length) detailParts.push("Missing attributes:\n" + mappingLines(unique))
      if (didYouMean && playwrightDidYouMean) {
        detailParts.push(`Pytest already told you the Python name: ${didYouMean}`)
      }
      if (asyncCm) {
        detailParts.push(
          "Use `async with page.expect_response(...)`, not `with page.expect_response(...)`.",
        )
      }
      if (st.jsApiErrors >= 2) {
        detailParts.push(
          "You already hit this JS-vs-Python error. Load skill `playwright-python` now. Do not edit-and-rerun.",
        )
      }
      output.output = `${output.output ?? ""}\n${hint(detailParts.join("\n"))}`
      await log("annotated js playwright pytest error", {
        sessionID: input.sessionID,
        count: st.jsApiErrors,
        names: unique,
      })
    },
  }
}
