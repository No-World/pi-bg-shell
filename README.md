# pi-bg-shell

**English** | [简体中文](./README.zh-CN.md)

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

Pi's built-in `bash` tool blocks the whole agent turn until the command finishes. A two-minute test suite means two minutes of a frozen session. `pi-bg-shell` gives the agent a tool family to fire long-running commands (builds, test suites, dev servers, watches) in the background and get **woken up** with the output the moment they exit — no polling, no babysitting.

## Tools

| Tool | What it does |
|------|--------------|
| `bash_bg` | Runs a command with `bash -c` in the background and returns immediately with a task id. Bounded tail buffers (1 MiB per stream) capture output; anything larger spills the full history to a file. |
| `bg_status` | Lists all tasks with one-line summaries, or fetches one task's full status and output tails by id. The listing also carries a **Global pool** section: detached tasks owned by other sessions, visible but not adopted here. |
| `bg_kill` | Terminates a task by id (default `SIGTERM`). Kill rights on a pool task belong to its creator or any subscriber — i.e. anyone who can see it in their own registry. |
| `bg_adopt` | Subscribes this session to a foreign pool task by manifest path (from bg_status's Global pool section): completion notices, pattern wakes, and kill rights follow (ADR-0007). |
| `powershell_bg` | Windows only: the `bash_bg` sibling for PowerShell — `pwsh.exe` when available, then Windows PowerShell, with the same argv prefix as pi's native `powershell` tool. Inactive by default; activate with `defaultTools: ["+powershell_bg"]` (ADR-0009). |

Completion is delivered as a `bg-shell-notify` message via `pi.sendMessage({ triggerTurn: true })` — the same wake primitive the official file-trigger example and pi-subagents' completion path use. Completions inside a 100 ms window merge into a single message, so a fan-out of tasks cannot stampede the session. Default wall-clock limit is 10 minutes per task (`timeout_sec` overrides; `0` disables).

### Wakes while a task is still running

Exit is not the only delivery moment anymore (ADR-0005):

- **`on_pattern`** — a literal substring watched line-by-line (grep semantics). The first matching line wakes the agent with the matched line plus the output tail; the task **keeps running**. `on_pattern_all` wakes on every match (rate-limited), `on_pattern_stop` stops the task right after delivering the match. `bg_status` shows `running·matched×N` as a sub-state while it runs. For alerts that can recur (watches), prefer `on_pattern_all` on a long-lived task (`timeout_sec: 0`) over re-spawning after each hit, and echo the marker on state transitions only — a persisting condition would otherwise re-wake at the 10 s floor.
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

### Detached tasks (survive quitting pi)

`bash_bg { detach: true }` runs the command in its own session (setsid) with output going straight to files — quitting pi **does not kill it** (rebooting the machine still does). The real exit code is recorded by a wrapper; a manifest under `tmpdir()/pi-bg-shell/` turns the root into a **machine-wide task pool** (ADR-0007): a session resumed with the same session id (`pi -c` / `--resume`) re-subscribes its survivors automatically; any other session sees them in bg_status's Global pool section and can adopt with `bg_adopt`. Deaths that happened while nobody watched are backfilled **once** by whichever session scans next — merged into one message and annotated `unattended — finished while pi was away` — so a "run and report back" promise survives any restart. The default timeout is off for detached tasks — pass `timeout_sec` explicitly if you want one.

```
You:     start the 24h device soak, detached, wake me on ROOTED
Agent:   bash_bg {command: "./soak.sh", detach: true, on_pattern: "ROOTED"}
… pi quits, reopened next morning …
Notify:  Background task #1 pattern match (on_pattern "ROOTED", match #1, running 9h12m): ./soak.sh
```

`bg_kill` signals the detached task's whole process group.

### Windows shells (ADR-0009)

**bash_bg** resolves bash exactly like the native `bash` tool: `shellPath` setting → Git Bash (`%ProgramFiles%\Git\bin\bash.exe`, then x86) → `bash.exe` on PATH. No bash anywhere → the same actionable error native prints (install Git for Windows / add to PATH / set `shellPath`). `shellCommandPrefix` is honored for bash tasks, like the native bash tool.

**powershell_bg** is the optional sibling of pi's `powershell` tool, present only on Windows and **inactive by default** — enable it the same way as the native tool:

```json
{ "defaultTools": ["+powershell", "+powershell_bg"] }
```

One settings line lights up both the foreground and the background PowerShell tools. Resolution matches native: `pwsh.exe` first, then Windows PowerShell, always `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` with the UTF-8 console-output header. The agent picks the shell by picking the tool — there is no per-call `shell` parameter, and there is no `cmd_bg` (native has no cmd tool either).

Detached tasks branch by interpreter flavor, all popup-free through the same GUI-subsystem wscript launcher (PITFALLS P8) and all killed via `taskkill /t /f`:

| Flavor | Wrapper | Output |
|--------|---------|--------|
| WSL relay | `.sh` with `/mnt/<drive>/…` paths (P6: never `-c` argv) | shell-side `>>` redirection |
| Git Bash / Cygwin / MSYS2 / custom `shellPath` | `.sh` with `C:/…` forward-slash paths | shell-side `>>` redirection |
| PowerShell | static `.cmd` template; the command rides the `PI_BG_SHELL_CMD` env var, exit code via a trailer inside the command | cmd's raw-byte `1>>/2>>` (PowerShell 5.1's own `>>` writes UTF-16LE) |

On Windows, `bash_bg` resolves bash exactly like pi's native `bash` tool (ADR-0009): the `shellPath` setting, then Git Bash under Program Files, then `bash.exe` on PATH — the WSL relay is the last resort, not the default. Detached machinery follows the resolved flavor. On the WSL relay, inherited Windows file handles cannot cross the boundary — detached tasks there switch to shell-side redirection (`( cmd ) >> OUT 2>> ERR` with `/mnt/<drive>/…`-translated paths), so output files and exit codes still land exactly where `bg_status` and pool scans expect them. The wrapper itself ships as a host-side script file (`bash <file>`, never `-c` argv) so the recorded exit code survives the relay's argument re-quoting. On Windows the detached relay is started through a GUI-subsystem wscript launcher — `detached` + `windowsHide` alone still pops a console — so spawns are popup-free and the task even survives the hosting terminal being closed. `bg_kill` on Windows terminates the whole relay tree via `taskkill /t /f` (there are no POSIX signals across the boundary) and writes a kill-attribution marker so other subscribers' notices say who killed the task. `on_pattern` watches an owned detached task's output from byte zero — early startup milestones wake the session just like adopted ones (which replay history). The pool is a bulletin board, not private property (ADR-0007): every session sees every manifest, subscription is a per-pid marker file (exclusive-create, so concurrent sessions never race), and artifacts are collected only once a task is terminal, reported, unsubscribed, and its creating process is gone.

## User surface

While tasks run, a card-style status widget sits above the input editor and repaints every 500 ms — elapsed times tick, spinners rotate, and each card shows the original command plus the task's current output and volume:

```
bg · background
   ⠸ #1 chatty-ticker · running · 1m 12s / 10m
     cmd: for i in $(seq 150); do echo …
     ⎿  ↓ 18.0k · [16:52:31] chatty heartbeat #93 …
   ⠋ #2 quiet-soak · running · 4m 2s / 10m
     cmd: sleep 300
 2 running · /bg panel
```

The header and task labels render plain; chrome (`· running ·`, `cmd:`, `⎿`) is dim, stats are muted, and commands plus live output lines use the toolOutput color. Every line is truncated to the terminal width. More than six running tasks collapse into `… +N more`; the widget (and its ticker) removes itself when the last task ends. Running rows append the timeout budget after the elapsed time (`1m 12s / 10m`) whenever one is armed — `timeout_sec: 0` and detached tasks (no default timeout) show none.

All information views open an overlay panel — never dump into the transcript:

| Command | What opens |
|---------|------------|
| `/bg` | Overlay panel: task list, `↑↓` select, `Enter` detail, `K` kill, `r` refresh, `q`/`esc` close |
| `/bg <id>` | The panel focused on one task's detail (status, exit code, command, running timeout with countdown, output tails, spill path) |
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
