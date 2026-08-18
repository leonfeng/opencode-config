# Local coding-model apply/archive/explore guardrails (KAT-Coder / vLLM)

After every successful implementation `write` or `edit`:
- The next tool call MUST edit the OpenSpec tasks file (`- [ ]` → `- [x]`). Do not write any other file until that succeeds.
- If the target file already exists from a successful write, mark the task complete. Do not rewrite it.
- Cycling the same two or more files (A then B then A) with no checkbox update is a loop. Stop, mark those tasks complete, and move on.

If a shell command already completed, do not run it again. Repeating `pytest`, `python -c`, grep, or ls is a loop: stop and use the previous output. After the test suite passes, do not run it again unless a later unfinished task requires it. Do not rerun the same pytest file/node — read the output you already have and edit the code.

If bash output says a session read cap was hit, that is **not** a rate limit. Do not `sleep` and retry `read`. Use grep for a missing symbol, or continue from files already in context.

If bash output says `bash tool terminated command after exceeding timeout`, OpenCode killed the **shell**, not pytest. pytest has **no** `--timeout` CLI flag — never add it. Do not rerun the full suite: use the partial output, run `-m 'not e2e'` for unit tests, or target one file/node (`tests/test_api.py::test_foo`). For long runs, pass a larger `timeout` on the bash tool (milliseconds), not a pytest flag.

OpenCode tools (`read`, `edit`, `write`, `glob`, `grep`) are function calls, not binaries. Never run tool names as shell commands (`edit << EOF` fails with command not found). Do not use `cat`/`head`/`tail` to read files (`read`), `cat >`/`sed -i` to write them (`write`/`edit`), or `ls`/`find` to list them (`glob`). Do not run `grep`/`rg` in bash — call the `grep` tool with pattern and path; count matches in its output if you need a number. Repeating a blocked bash stand-in is a loop: switch to the OpenCode tool immediately. Use bash only for programs on PATH (git, pytest, python, openspec). To change a file, call `edit` with filePath, oldString, and newString.

`openspec validate` takes a positional name: `openspec validate "<name>"`. It has no `--change` flag — that flag is for `status` and `instructions`. `--changes` (plural) validates every change and takes no name. Do not run `openspec validate --help` to rediscover this.

During `/opsx-explore`:
- Thinking only. Do not implement even if the user says "fix it."
- Do not rerun the same command. After you have answered, stop.
- Grep for symbols. Do not read entire test files or dump every `.py` file into context.
- Do not re-read a file whose previous read succeeded.
- After a handful of targeted reads, close the think block and write findings. Reading the whole repository is a loop: stop and answer.
- If there is no topic, offer a few directions and wait.

During `/opsx-archive` spec sync:
- Merge delta specs in this conversation. Do not read a `SKILL.md`, command file, or `.opencode`/`.agents` skill path to invoke sync.
- If a main spec is missing at `openspec/specs/<capability>/spec.md`, create it from ADDED. Do not search the repo for other `*specs*` paths.
- Do not re-read a file whose previous read succeeded.

After specs are handled, archive with exactly one command:
`openspec archive "<name>" --skip-specs --yes`
Do not mkdir, mv, or rm the change directory. Creating a directory and then deleting it is a loop: stop.
