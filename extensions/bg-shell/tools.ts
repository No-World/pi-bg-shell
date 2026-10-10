/**
 * Model-facing tool definitions for bg-shell.
 *
 * Five tools share the TaskRegistry: bash_bg starts a detached-from-turn
 * child and returns immediately; bg_status inspects tasks and output tails;
 * bg_kill terminates one; bg_adopt subscribes this session to a foreign
 * global-pool task (ADR-0007). All run sequentially per Pi's contract for
 * tools sharing mutable in-memory state.
 */

import { Type, type Static } from "typebox";
import { resolveBashSpec, resolvePowerShellSpec, type ShellSettings, type ShellSpec } from "./shell.ts";
import type { ForeignTaskInfo, TaskOutput, TaskRegistry, TaskSnapshot, TaskStatus } from "./tasks.ts";

const BgSharedParams = {
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
	timeout_sec: Type.Optional(
		Type.Number({
			description:
				"Kill the task after this many seconds. Default 600, or the PI_BG_SHELL_TIMEOUT_SEC env var; 0 disables the timeout.",
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				'Extra environment variables merged over the current one (e.g. {"ADB": "/opt/bin/adb"}). ' +
				"Each task starts a fresh shell — pass variables here instead of re-declaring inline VAR=... prefixes in every command.",
		}),
	),
	label: Type.Optional(Type.String({ description: "Short human label; defaults to the command prefix." })),
	on_pattern: Type.Optional(
		Type.String({
			description:
				'Literal string; wake the agent the first time an output line contains it (e.g. "ROOTED"). The task keeps running unless on_pattern_stop is set. For alerts that can recur (watches), prefer on_pattern_all on a long-lived task (timeout_sec 0) over re-spawning after each hit.',
		}),
	),
	on_pattern_all: Type.Optional(
		Type.Boolean({
			description:
				'With on_pattern: fire on every matching line (rate-limited) instead of only the first. For watches, echo the marker on state transitions only — a condition that persists would otherwise re-wake the agent at the 10 s floor.',
		}),
	),
	on_pattern_stop: Type.Optional(
		Type.Boolean({ description: "With on_pattern: stop the task (SIGTERM) right after delivering the match notification." }),
	),
	report_every_sec: Type.Optional(
		Type.Number({
			description:
				"While the task runs, deliver a progress report (elapsed + output tail) every this many seconds, without interrupting it. Clamped to >= 5.",
		}),
	),
	detach: Type.Optional(
		Type.Boolean({
			description:
				"Run detached from the pi process: the task survives pi quitting (machine reboots still kill it). Output goes to a machine-wide pool; a session resumed with the same session id re-subscribes automatically, any other session sees it in bg_status and can adopt it with bg_adopt. Timeout defaults to off.",
		}),
	),
};

const BashBgParams = Type.Object({
	command: Type.String({ description: "Shell command to run (executed with bash -c)." }),
	...BgSharedParams,
});

const PowershellBgParams = Type.Object({
	command: Type.String({
		description:
			"PowerShell command to run (executed via pwsh/powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command).",
	}),
	...BgSharedParams,
});

const BgStatusParams = Type.Object({
	id: Type.Optional(Type.Number({ description: "Task id from bash_bg. Omit to list all tasks." })),
	tail_bytes: Type.Optional(
		Type.Number({ description: "How many tail bytes of output to include for one task. Default 65536." }),
	),
});

const BgKillParams = Type.Object({
	id: Type.Number({ description: "Task id from bash_bg." }),
	signal: Type.Optional(
		Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL"), Type.Literal("SIGINT"), Type.Literal("SIGHUP")], {
			description: "Termination signal. Default SIGTERM.",
		}),
	),
});

const BgAdoptParams = Type.Object({
	path: Type.String({
		description:
			"Manifest path of a foreign global-pool task, as listed by bg_status's Global pool section (ADR-0007).",
	}),
});

export interface BgToolDeps {
	registry: TaskRegistry;
	/** Called after state changes (task started / killed) so the host can refresh UI. */
	onChange?: () => void;
	/** pi settings accessor: shellPath steers bash resolution, shellCommandPrefix is prepended (native parity, ADR-0009). */
	getSettings?: () => ShellSettings & { shellCommandPrefix?: string };
	/** Override bash resolution for tests (ADR-0009). */
	resolveBash?: () => ShellSpec;
	/** Override PowerShell resolution for tests (ADR-0009). */
	resolvePowerShell?: () => ShellSpec;
}

/** Models sometimes emit "#3" or "3" for an id field; normalize before validation. */
function coerceNumericId(args: unknown): any {
	if (args === null || typeof args !== "object") return args;
	const record = args as Record<string, unknown>;
	if (record.id !== undefined && typeof record.id === "string") {
		const trimmed = record.id.replace(/^#/, "").trim();
		if (/^\d+$/.test(trimmed)) return { ...record, id: Number(trimmed) };
	}
	return args;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}h${minutes % 60}m`;
	}
	return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function patternSummary(state: TaskSnapshot["pattern"]): string {
	if (!state || state.matches === 0) return "armed, no match yet";
	return `matched ×${state.matches}, last: ${state.lastLine.slice(0, 200)} (${state.lastStream})`;
}

function summaryLine(task: TaskSnapshot, nowMs: number): string {
	const matched = task.pattern !== undefined && task.pattern.matches > 0 ? `·matched×${task.pattern.matches}` : "";
	const time =
		task.status === "running"
			? `running${matched} ${formatDuration(Math.max(0, nowMs - task.startedAt))}`
			: `${task.status}${task.exitCode !== null ? ` exit ${task.exitCode}` : ""}${
					task.durationMs !== undefined ? ` in ${formatDuration(task.durationMs)}` : ""
				}`;
	return `#${task.id} ${time} pid ${task.pid ?? "-"} · ${task.label}`;
}

function outputBlock(name: string, tail: string, totalBytes: number, truncated: boolean, spillPath: string | undefined): string {
	if (totalBytes === 0 && tail === "") return `--- ${name} (empty) ---`;
	const spill = truncated && spillPath ? `; full output: ${spillPath}` : "";
	return `--- ${name} tail (${tail.length}/${totalBytes} bytes${spill}) ---\n${tail}`;
}

export interface BgStatusDetails {
	task?: TaskSnapshot;
	output?: TaskOutput | null;
	tasks?: TaskSnapshot[];
	foreign?: ForeignTaskInfo[];
}

export interface BgKillDetails {
	id: number;
	status?: TaskStatus;
	signal?: string;
	killed: boolean;
}

export function bashBgTool(deps: BgToolDeps) {
	return {
		name: "bash_bg",
		label: "Background shell",
		description:
			"Run a shell command in the background and return immediately with a task id. " +
			"Use this instead of bash for long-running commands (builds, test suites, dev servers, file watches, retries with sleep) " +
			"so the session stays responsive. When the command exits, a completion notification with the output tail arrives automatically — do not poll.",
		promptSnippet:
			"bash_bg — run a shell command in the background; output is delivered when it exits; " +
			"cwd/env params set the working directory and variables (fresh shell per task)",
		promptGuidelines: [
			"Prefer bash_bg over bash for any command expected to take longer than a few seconds (builds, test suites, dev servers, watches).",
			"bash_bg returns immediately; results arrive as a bg-shell-notify completion message — never poll in a loop, just continue other work.",
			"Progress checks and terminations go through bg_status and bg_kill, not ps/grep/kill via bash.",
			"Each bash_bg task runs in a fresh bash -c shell with no session state — pass cwd and env instead of re-declaring inline VAR=... prefixes in every command.",
			"For tasks that must outlive the session (multi-hour runners), pass detach: true — the task survives quitting pi and the next session re-adopts it automatically.",
		],
		parameters: BashBgParams,
		executionMode: "sequential" as const,
		async execute(
			_toolCallId: string,
			params: Static<typeof BashBgParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			// Native parity (ADR-0009): resolve bash exactly like the built-in bash
			// tool (shellPath setting → Git Bash → PATH) and honor its
			// shellCommandPrefix (joined with a newline, same as native).
			const settings = deps.getSettings?.() ?? {};
			const spec = deps.resolveBash !== undefined ? deps.resolveBash() : resolveBashSpec(settings);
			const prefix = settings.shellCommandPrefix?.trim();
			const command = prefix !== undefined && prefix !== "" ? `${prefix}\n${params.command}` : params.command;
			const snapshot = deps.registry.start({
				command,
				cwd: params.cwd,
				timeoutMs: params.timeout_sec !== undefined ? Math.max(0, params.timeout_sec) * 1000 : undefined,
				env: params.env,
				label: params.label,
				pattern:
					params.on_pattern !== undefined
						? {
								literal: params.on_pattern,
								all: params.on_pattern_all ?? false,
								stop: params.on_pattern_stop ?? false,
							}
						: undefined,
				reportEveryMs:
					params.report_every_sec !== undefined ? Math.max(5, params.report_every_sec) * 1000 : undefined,
				detach: params.detach ?? false,
				shell: spec,
			});
			deps.onChange?.();
			const extras: string[] = [];
			if (params.on_pattern !== undefined) {
				extras.push(
					`Armed on_pattern "${params.on_pattern}" — you will be woken when it appears in the output; ` +
						(params.on_pattern_stop ? "the task is then stopped." : "the task keeps running."),
				);
			}
			if (params.report_every_sec !== undefined) {
				extras.push(`Progress reports arrive every ${Math.max(5, params.report_every_sec)}s while it runs.`);
			}
			if (params.detach) {
				extras.push(
					"Detached: survives pi quitting; the next session re-adopts it automatically. " +
						(snapshot.timeoutMs > 0 ? `Timeout ${snapshot.timeoutMs / 1000}s still applies.` : "No default timeout."),
				);
			}
			const text =
				`Started background task #${snapshot.id} (pid ${snapshot.pid ?? "?"}): ${snapshot.label}\n` +
				(extras.length > 0 ? `${extras.join("\n")}\n` : "") +
				`A completion notification with the output arrives automatically on exit — continue working; do not poll.\n` +
				`On-demand checks: bg_status {"id": ${snapshot.id}} for progress, bg_kill {"id": ${snapshot.id}} to stop it.`;
			return {
				content: [{ type: "text" as const, text }],
				details: { id: snapshot.id, pid: snapshot.pid, command: snapshot.command, timeoutMs: snapshot.timeoutMs },
			};
		},
	};
}

/**
 * powershell_bg — the background sibling of pi's optional native powershell
 * tool (ADR-0009). Registered on win32 only and inactive by default, exactly
 * like the native tool: activate with defaultTools ["+powershell_bg"] (one
 * settings line lights up both the native foreground tool and this one).
 * Resolution mirrors native too: pwsh.exe when available, then Windows
 * PowerShell. The agent picks the shell by picking the tool — bash_bg vs
 * powershell_bg — never a per-call parameter.
 */
export function powershellBgTool(deps: BgToolDeps) {
	return {
		name: "powershell_bg",
		label: "Background PowerShell",
		defaultActive: false,
		description:
			"Run a PowerShell command in the background and return immediately with a task id — the background " +
			"sibling of the powershell tool (pwsh.exe when available, then Windows PowerShell). " +
			"Same semantics as bash_bg: a completion notification with the output tail arrives on exit — do not poll.",
		promptSnippet:
			"powershell_bg — run a PowerShell command in the background; output is delivered when it exits; " +
			"prefer this over the powershell tool for commands expected to take longer than a few seconds",
		promptGuidelines: [
			"Use powershell_bg instead of powershell for long-running commands (builds, test suites, dev servers, watches) so the session stays responsive.",
			"Pick the shell by picking the tool: bash_bg for bash syntax, powershell_bg for PowerShell syntax — there is no shell parameter.",
		],
		parameters: PowershellBgParams,
		executionMode: "sequential" as const,
		async execute(
			_toolCallId: string,
			params: Static<typeof PowershellBgParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const spec = deps.resolvePowerShell !== undefined ? deps.resolvePowerShell() : resolvePowerShellSpec();
			const snapshot = deps.registry.start({
				command: params.command,
				cwd: params.cwd,
				timeoutMs: params.timeout_sec !== undefined ? Math.max(0, params.timeout_sec) * 1000 : undefined,
				env: params.env,
				label: params.label,
				pattern:
					params.on_pattern !== undefined
						? {
								literal: params.on_pattern,
								all: params.on_pattern_all ?? false,
								stop: params.on_pattern_stop ?? false,
							}
						: undefined,
				reportEveryMs:
					params.report_every_sec !== undefined ? Math.max(5, params.report_every_sec) * 1000 : undefined,
				detach: params.detach ?? false,
				shell: spec,
			});
			deps.onChange?.();
			const text =
				`Started background task #${snapshot.id} (pwsh, pid ${snapshot.pid ?? "?"}): ${snapshot.label}\n` +
				`A completion notification with the output arrives automatically on exit — continue working; do not poll.\n` +
				`On-demand checks: bg_status {"id": ${snapshot.id}} for progress, bg_kill {"id": ${snapshot.id}} to stop it.`;
			return {
				content: [{ type: "text" as const, text }],
				details: { id: snapshot.id, pid: snapshot.pid, command: snapshot.command, timeoutMs: snapshot.timeoutMs },
			};
		},
	};
}

export function bgStatusTool(deps: BgToolDeps) {
	return {
		name: "bg_status",
		label: "Background task status",
		description:
			"Source of truth for background tasks started with bash_bg: list tasks with one-line summaries, " +
			"or fetch one task's live status and output tails by id. The in-memory buffers and the id↔pid mapping " +
			"are visible only here — ps/grep/tail through bash cannot find task ids or un-spilled output. " +
			"Use it whenever a bg-shell-notify completion message arrives or progress is needed.",
		promptSnippet:
			"bg_status — inspect background tasks (live output tails, ids, statuses); the registry is the source of truth, not ps/grep/tail",
		promptGuidelines: [
			"Background tasks started with bash_bg live in an in-memory registry: check them with bg_status, never by piping ps/grep/tail through bash — task ids and live buffers are invisible to bash.",
			"When a bg-shell-notify message truncates output or you need a task's current progress, call bg_status with the id from the #N header (e.g. id: 3).",
		],
		parameters: BgStatusParams,
		executionMode: "sequential" as const,
		prepareArguments: coerceNumericId,
		async execute(
			_toolCallId: string,
			params: Static<typeof BgStatusParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		): Promise<{ content: { type: "text"; text: string }[]; details: BgStatusDetails }> {
			const now = Date.now();
			if (params.id !== undefined) {
				const snapshot = deps.registry.status(params.id)[0];
				if (!snapshot) throw new Error(`No background task with id ${params.id}`);
				const output = deps.registry.output(params.id, params.tail_bytes);
				const text =
					`Task #${snapshot.id} ${snapshot.status}` +
					`${snapshot.exitCode !== null ? ` (exit ${snapshot.exitCode})` : ""}` +
					`${snapshot.signal ? ` (signal ${snapshot.signal})` : ""}\n` +
					`command: ${snapshot.command}\ncwd: ${snapshot.cwd}\n` +
				(snapshot.detached
					? `detached: survives session exit${snapshot.adopted ? "; adopted from a previous session" : ""}\n`
					: "") +
					(snapshot.status === "running"
						? `running for ${formatDuration(now - snapshot.startedAt)}, timeout ${formatDuration(snapshot.timeoutMs)}\n`
						: `duration: ${snapshot.durationMs !== undefined ? formatDuration(snapshot.durationMs) : "?"}\n`) +
					(snapshot.errorMessage !== undefined ? `error: ${snapshot.errorMessage}\n` : "") +
					(snapshot.pattern !== undefined
						? `on_pattern "${snapshot.pattern.literal}": ${patternSummary(snapshot.pattern)}\n`
						: "") +
					(snapshot.reportEveryMs !== undefined && snapshot.status === "running"
						? `reporting every ${Math.round(snapshot.reportEveryMs / 1000)}s while running\n`
						: "") +
					(output
						? `${outputBlock("stdout", output.stdoutTail, output.stdoutBytes, output.stdoutTruncated, output.stdoutSpillPath)}\n` +
							`${outputBlock("stderr", output.stderrTail, output.stderrBytes, output.stderrTruncated, output.stderrSpillPath)}`
						: "");
				return { content: [{ type: "text" as const, text }], details: { task: snapshot, output: output ?? null } };
			}
			const snapshots = deps.registry.status();
			const foreign = deps.registry.listForeign();
			if (snapshots.length === 0 && foreign.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No background tasks have been started in this session." }],
					details: { tasks: [], foreign: [] },
				};
			}
			const lines = snapshots.map((task) => summaryLine(task, now));
			if (foreign.length > 0) {
				lines.push(
					"",
					'Global pool (foreign — not adopted here; bg_adopt {"path": …} subscribes):',
				);
				for (const task of foreign) {
					lines.push(
						`- ${task.alive ? "running" : "terminal"} pid ${task.pid} · ${task.label} · ${task.manifestPath}`,
					);
				}
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { tasks: snapshots, foreign } };
		},
	};
}

export function bgKillTool(deps: BgToolDeps) {
	return {
		name: "bg_kill",
		label: "Kill background task",
		description:
			"Terminate a background shell task by id (default SIGTERM). Use for dev servers or watches that no longer need to run. " +
			"Covers host-side registry tasks only.",
		promptSnippet: "bg_kill — terminate a background task by id (id from bash_bg or a #N header)",
		promptGuidelines: [
			"Stop background tasks with bg_kill rather than kill/pkill through bash: the registry then reports the task as killed instead of failed.",
			"For mixed targets (a local task plus processes on a device), stop the local side with bg_kill and keep adb/ssh kill commands for the remote side — never raw-kill a pid that bash_bg owns.",
		],
		parameters: BgKillParams,
		executionMode: "sequential" as const,
		prepareArguments: coerceNumericId,
		async execute(
			_toolCallId: string,
			params: Static<typeof BgKillParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		): Promise<{ content: { type: "text"; text: string }[]; details: BgKillDetails }> {
			const existing = deps.registry.status(params.id)[0];
			if (!existing) throw new Error(`No background task with id ${params.id}`);
			if (existing.status !== "running") {
				return {
					content: [{ type: "text" as const, text: `Task #${params.id} already ${existing.status}; nothing to kill.` }],
					details: { id: params.id, status: existing.status, killed: false },
				};
			}
			deps.registry.kill(params.id, params.signal ?? "SIGTERM");
			deps.onChange?.();
			return {
				content: [{ type: "text" as const, text: `Sent ${params.signal ?? "SIGTERM"} to task #${params.id} (${existing.label}).` }],
				details: { id: params.id, signal: params.signal ?? "SIGTERM", killed: true },
			};
		},
	};
}

export interface BgAdoptDetails {
	id: number;
	label: string;
	status: TaskStatus;
	manifestPath: string;
}

export function bgAdoptTool(deps: BgToolDeps) {
	return {
		name: "bg_adopt",
		label: "Adopt pool task",
		description:
			"Subscribe this session to a detached task from the global pool that this session did not start " +
			"(another session's task, or a legacy manifest). The adopted task gains wake rights here: completion " +
			"notices, on_pattern matches, and death backfills. Kill rights belong to the creator or any subscriber.",
		promptSnippet:
			"bg_adopt — subscribe to a foreign pool task by manifest path (from bg_status's Global pool section); wakes and kill rights follow",
		promptGuidelines: [
			"bg_status lists foreign detached tasks under 'Global pool' — adopt one with bg_adopt before killing it or waiting on its output; same-session survivors are re-subscribed automatically and never need this.",
		],
		parameters: BgAdoptParams,
		executionMode: "sequential" as const,
		async execute(
			_toolCallId: string,
			params: Static<typeof BgAdoptParams>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		): Promise<{ content: { type: "text"; text: string }[]; details: BgAdoptDetails }> {
			const snapshot = deps.registry.adoptByPath(params.path);
			deps.onChange?.();
			const text =
				`Adopted pool task as #${snapshot.id} (${snapshot.label}) — ${snapshot.status === "running" ? "running; subscribed" : `terminal (${snapshot.status}${snapshot.exitCode !== null ? `, exit ${snapshot.exitCode}` : ""})`}. ` +
				(snapshot.status === "running"
					? "Completion and on_pattern wakes now arrive here; bg_kill can stop it."
					: "Outcome registered; bg_status fetches the output.");
			return {
				content: [{ type: "text" as const, text }],
				details: { id: snapshot.id, label: snapshot.label, status: snapshot.status, manifestPath: params.path },
			};
		},
	};
}
