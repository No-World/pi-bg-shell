# pi-bg-shell

Background shell tasks for the [Pi coding agent](https://github.com/earendil-works/pi) — Claude Code style: start a command, keep working, get the output delivered automatically when it exits.

```
You:     run the test suite, and meanwhile draft the changelog
Agent:   bash_bg  →  Started background task #1 (pid 4242): npm test
Agent:   (works on the changelog, answers you, reads files …)
Notify:  Background task #1 completed (exit 0, 42.1s): npm test
         --- stdout tail (1234/5678 bytes) ---
         …
```

## Why

Pi's built-in `bash` tool blocks the whole agent turn until the command finishes. A two-minute test suite means two minutes of a frozen session. `pi-bg-shell` gives the agent three tools to fire long-running commands (builds, test suites, dev servers, watches) in the background and get **woken up** with the output the moment they exit — no polling, no babysitting.

## Tools

| Tool | What it does |
|------|--------------|
| `bash_bg` | Runs a command with `bash -c` in the background and returns immediately with a task id. Bounded tail buffers (1 MiB per stream) capture output; anything larger spills the full history to a file. |
| `bg_status` | Lists all tasks with one-line summaries, or fetches one task's full status and output tails by id. |
| `bg_kill` | Terminates a task by id (default `SIGTERM`). |

Completion is delivered as a `bg-shell-notify` message via `pi.sendMessage({ triggerTurn: true })` — the same wake primitive the official file-trigger example and pi-subagents' completion path use. Completions inside a 100 ms window merge into a single message, so a fan-out of tasks cannot stampede the session. Default wall-clock limit is 10 minutes per task (`timeout_sec` overrides; `0` disables).

### Wakes while a task is still running

Exit is not the only delivery moment anymore (ADR-0005):

- **`on_pattern`** — a literal substring watched line-by-line (grep semantics). The first matching line wakes the agent with the matched line plus the output tail; the task **keeps running**. `on_pattern_all` wakes on every match (rate-limited), `on_pattern_stop` stops the task right after delivering the match. `bg_status` shows `running·matched×N` as a sub-state while it runs.
- **`report_every_sec`** — while the task runs, a progress report (elapsed time + output tail) arrives every N seconds (clamped to ≥ 5) without interrupting it.

```
Agent:   bash_bg {command: "./day_runner.sh", timeout_sec: 0,
         on_pattern: "ROOTED", report_every_sec: 600}
Notify:  Background task #4 still running (600.2s elapsed, report every 600s): ./day_runner.sh …
Notify:  Background task #4 pattern match (on_pattern "ROOTED", match #1, running 1412.8s): ./day_runner.sh
         --- matched line (stdout) ---
         ROOTED device 3 ready
         …
```

Both are delivery-timing controls, not orchestration: what to do next stays with the woken agent in the conversation.

## User surface

While tasks run, a one-line status widget sits above the editor (the fleet-style bar):

```
▶ bg 2 running: #1 npm test (1m12s) · #2 vite dev (0m31s) — /bg panel
```

All information views open an overlay panel — never dump into the transcript:

| Command | What opens |
|---------|------------|
| `/bg` | Overlay panel: task list, `↑↓` select, `Enter` detail, `K` kill, `r` refresh, `q`/`esc` close |
| `/bg <id>` | The panel focused on one task's detail (status, exit code, command, output tails, spill path) |
| `/bg tail <id> [bytes]` | Same detail view with a larger output tail (default 4096 bytes) |
| `/bg log <id>` | Same detail view; truncated tasks show their full-output spill path |
| `/bg kill <id> [signal]` | Terminates a task (default `SIGTERM`) with a toast ack |

Tab-completion offers subcommands and task ids. Headless modes (RPC/JSON/print) degrade to notify summaries.

## Install

```bash
pi install git:github.com/No-World/pi-bg-shell
```

Or for local development:

```bash
git clone https://github.com/No-World/pi-bg-shell
pi --extension /path/to/pi-bg-shell/extensions/bg-shell/index.ts
```

Reloads (`/reload`) and session switches keep running tasks alive; quitting pi SIGTERMs+SIGKILLs every child and removes spill files.

## Configuration

| Env var | Effect |
|---------|--------|
| `PI_BG_SHELL_TIMEOUT_SEC` | Default wall-clock limit per task when `timeout_sec` is omitted. Defaults to `600`; set `0` to disable the default. Read once at pi startup — restarting pi applies a new value. |

An explicit `timeout_sec` on a `bash_bg` call always wins over the environment default.

## How the wake works

1. `bash_bg` spawns the child; the tool result returns instantly.
2. On exit, the registry emits the final snapshot through its `onExit` hook.
3. A debounce window (100 ms) batches concurrent completions into one message.
4. The notifier calls `pi.sendMessage(..., { triggerTurn: true })` — an idle session starts a new agent turn; a busy session gets the message queued by pi.
5. The agent reads the output tail (and the spill-file path for full output) and continues.

The task registry lives on `globalThis` (a `Symbol.for` key), so it survives extension reloads; the entry point rebinds the exit hook on every load so post-reload completions still reach the agent. Design trade-offs are recorded in [docs/adrs/0003-background-shell-wake-mechanism.md](docs/adrs/0003-background-shell-wake-mechanism.md).

## Development

```bash
npm install
npm test             # node:test suite + mechanical doc gates
npm run typecheck    # strict TypeScript check
npm run check:docs   # doc gates alone
pi --extension .     # exercise interactively
```

The repository keeps the full engineering harness: ADRs with a mechanical index gate ([docs/adrs/README.md](docs/adrs/README.md)), a pitfalls handbook ([docs/PITFALLS.md](docs/PITFALLS.md)), postmortem loop templates ([docs/postmortems/README.md](docs/postmortems/README.md)), a ubiquitous-language glossary ([CONTEXT.md](CONTEXT.md)), and a CI lane that mirrors the local gate on every PR ([.github/workflows/pr-checks.yml](.github/workflows/pr-checks.yml)). Contribution rules live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
