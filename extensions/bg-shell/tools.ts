/**
 * Model-facing tool definitions for bg-shell.
 *
 * Three tools share the TaskRegistry: bash_bg starts a detached-from-turn
 * child and returns immediately; bg_status inspects tasks and output tails;
 * bg_kill terminates one. All three run sequentially per Pi's contract for
 * tools sharing mutable in-memory state.
 */

import { Type, type Static } from "typebox";
import type { TaskOutput, TaskRegistry, TaskSnapshot, TaskStatus } from "./tasks.ts";

const BashBgParams = Type.Object({
	command: Type.String({ description: "Shell command to run (executed with bash -c)." }),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
	timeout_sec: Type.Optional(
		Type.Number({ description: "Kill the task after this many seconds. Default 600; 0 disables the timeout." }),
	),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables." })),
	label: Type.Optional(Type.String({ description: "Short human label; defaults to the command prefix." })),
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

export interface BgToolDeps {
	registry: TaskRegistry;
	/** Called after state changes (task started / killed) so the host can refresh UI. */
	onChange?: () => void;
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

function summaryLine(task: TaskSnapshot, nowMs: number): string {
	const time =
		task.status === "running"
			? `running ${formatDuration(Math.max(0, nowMs - task.startedAt))}`
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
		promptSnippet: "bash_bg — run a shell command in the background; output is delivered when it exits",
		promptGuidelines: [
			"Prefer bash_bg over bash for any command expected to take longer than a few seconds (builds, test suites, dev servers, watches).",
			"bash_bg returns immediately; results arrive as a bg-shell-notify completion message — never poll in a loop, just continue other work.",
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
			const snapshot = deps.registry.start({
				command: params.command,
				cwd: params.cwd,
				timeoutMs: params.timeout_sec !== undefined ? Math.max(0, params.timeout_sec) * 1000 : undefined,
				env: params.env,
				label: params.label,
			});
			deps.onChange?.();
			const text =
				`Started background task #${snapshot.id} (pid ${snapshot.pid ?? "?"}): ${snapshot.label}\n` +
				`A completion notification with the output arrives automatically on exit — continue working; do not poll.`;
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
			"List background shell tasks (running and recently finished) with one-line summaries, " +
			"or fetch one task's full status and output tails by id. Use this to check on a task the completion message referred to.",
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
					(snapshot.status === "running"
						? `running for ${formatDuration(now - snapshot.startedAt)}, timeout ${formatDuration(snapshot.timeoutMs)}\n`
						: `duration: ${snapshot.durationMs !== undefined ? formatDuration(snapshot.durationMs) : "?"}\n`) +
					(snapshot.errorMessage !== undefined ? `error: ${snapshot.errorMessage}\n` : "") +
					(output
						? `${outputBlock("stdout", output.stdoutTail, output.stdoutBytes, output.stdoutTruncated, output.stdoutSpillPath)}\n` +
							`${outputBlock("stderr", output.stderrTail, output.stderrBytes, output.stderrTruncated, output.stderrSpillPath)}`
						: "");
				return { content: [{ type: "text" as const, text }], details: { task: snapshot, output: output ?? null } };
			}
			const snapshots = deps.registry.status();
			if (snapshots.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No background tasks have been started in this session." }],
					details: { tasks: [] },
				};
			}
			const lines = snapshots.map((task) => summaryLine(task, now));
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { tasks: snapshots } };
		},
	};
}

export function bgKillTool(deps: BgToolDeps) {
	return {
		name: "bg_kill",
		label: "Kill background task",
		description:
			"Terminate a background shell task by id (default SIGTERM). Use for dev servers or watches that no longer need to run.",
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
