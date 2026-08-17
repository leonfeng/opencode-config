# opencode-config

Personal [OpenCode](https://opencode.ai) setup for local vLLM models, with plugins and instructions that keep coding agents from looping, misusing the shell, or writing JavaScript Playwright APIs in Python.

## Runtime

- **Provider:** local vLLM (`http://127.0.0.1:8000/v1`) via `@ai-sdk/openai-compatible`
- **Default model:** BigBang V1 (reasoning)
- **All tasks (small / title / summary / compaction):** same BigBang V1 endpoint
- **Also configured (not currently served):** KAT-Coder V2.5, Muse Glimmer 30B, Gemma 4 26B-A4B
- **MCP:** Playwright (`pnpx @playwright/mcp@latest`)

## Plugins

| Plugin | What it does |
|---|---|
| `tool-not-shell` | Blocks bash stand-ins for OpenCode tools (`cat`, `sed`, `ls`, `grep`, `edit`, …). Escalates on repeat attempts (shell stand-in loop). Append `# confirm` to run anyway. Also corrects invalid `openspec validate` flags. |
| `stop-think-loop` | Recovers when a reply hits the output token limit while still thinking: strips stalled reasoning, disables thinking, and prompts a visible reply. Re-recovers after productive turns (sentinel stays in history but no longer blocks). Build agent on reasoning models (BigBang): thinking disabled proactively with 8k output cap. Once a session stalls, output drops to 4k for the rest of the session. Strips spent reasoning from tool/text turns. Caps compaction output, turns off overflow autocontinue, and merges extra system prompts so Qwen/vLLM does not 400 on title generation. |
| `stop-dump-loop` | Stops repeat full-file reads. In explore mode, also caps unique files, total bytes, and whole-file size. |
| `playwright-python-api` | Rejects JavaScript Playwright APIs (`waitForTimeout`, `getByRole`, sync `with page.expect_response`) in Python writes/edits, and annotates pytest `AttributeError` output with snake_case mappings. |
| `stop-pytest-timeout-loop` | Raises bash timeout to 10 min for pytest, blocks hallucinated `pytest --timeout`, stops repeat full-suite runs after an OpenCode bash kill, and annotates timeout output. |

## Skills and instructions

- **`playwright-python`** — load before writing Playwright Python tests. Documents snake_case APIs, `async with expect_response`, and the official Page docs.
- **`no-rewrite-loop.md`** — after a successful write/edit, mark the OpenSpec task done; do not rewrite existing files or rerun finished commands; use OpenCode tools instead of shell stand-ins; explore/archive stop conditions.
- **`library-docs.md`** — for unfamiliar libraries, load a skill or fetch official docs instead of guessing (Playwright Python is the worked example).
