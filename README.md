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
| `tool-not-shell` | Blocks bash stand-ins for OpenCode tools (`cat`, `sed`, `ls`, `grep`, `edit`, …). Escalates on repeat attempts. Blocks bare `sleep` (and long sleeps after a read cap). After 6 consecutive blocked tools on a **child** session, aborts that child so it cannot crash vLLM. Primary apply is never auto-aborted. Append `# confirm` to run anyway. |
| `stop-think-loop` | Recovers when a reply hits the output token limit while still thinking: strips stalled reasoning, disables thinking, and prompts a visible reply. Re-recovers after productive turns (sentinel stays in history but no longer blocks). Build agent on reasoning models (BigBang): thinking disabled proactively with 8k output cap. Once a session stalls, output drops to 4k for the rest of the session. Strips spent reasoning from tool/text turns. Caps compaction output, turns off overflow autocontinue, and merges extra system prompts so Qwen/vLLM does not 400 on title generation. |
| `stop-dump-loop` | Stops repeat full-file reads. Explore mode caps unique files, total bytes, and whole-file size. Build/apply caps at 48 files / 200k bytes but still allows unread package modules, tests, OpenSpec files, `pyproject.toml`, and small templates. Dump-cap errors say this is not a rate limit and do not abort the session. |
| `stop-python-c-loop` | Blocks repeat inline `python -c` / `uv run python -c` debug scripts and caps TestClient/uvicorn/inspect variants per session. Repeat blocks on a child session count toward abort. |
| `stop-edit-loop` | Blocks identical old/new edits, repeat exact edits, and further edits on a file after several failures. BigBang often retries "no changes to apply" forever without this. |
| `stop-agent-loop` | **Generic** stuck-session guard: blocks the 3rd identical tool call (git diff, read, edit, grep, pytest, …) and halts after 20 steps (12 on child sessions) with no successful write/edit. Catches loops that succeed but never advance. |
| `stop-tool-loop-abort` | After 6 consecutive blocked tools, aborts **child** sessions only. vLLM is served with `max-num-seqs=2`; a looping explore child plus parent streaming kills EngineCore. Primary apply is never auto-aborted (that looked like a keypress interrupt). |
| `playwright-python-api` | Rejects JavaScript Playwright APIs (`waitForTimeout`, `getByRole`, sync `with page.expect_response`) in Python writes/edits, and annotates pytest `AttributeError` output with snake_case mappings. |
| `stop-pytest-timeout-loop` | Raises bash timeout to 10 min for pytest (including `uv run pytest`), blocks hallucinated `pytest --timeout`, stops repeat runs on the same file/node, stops repeat full-suite runs after an OpenCode bash kill, and annotates timeout output. |

## Skills and instructions

- **`playwright-python`** — load before writing Playwright Python tests. Documents snake_case APIs, `async with expect_response`, and the official Page docs.
- **`openspec-split-change`** — via [LocalSpec](https://github.com/leonfeng/LocalSpec): run `localspec update` (not bare `openspec update`) to keep split + local-model skill overlays on upstream OpenSpec.
- **`no-rewrite-loop.md`** — after a successful write/edit, mark the OpenSpec task done; do not rewrite existing files or rerun finished commands; use OpenCode tools instead of shell stand-ins; explore/archive stop conditions.
- **`library-docs.md`** — for unfamiliar libraries, load a skill or fetch official docs instead of guessing (Playwright Python is the worked example).
