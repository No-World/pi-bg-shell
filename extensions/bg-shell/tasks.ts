/**
 * Background task registry — the process-level core of bg-shell.
 *
 * Owns spawned child processes, captures output into bounded tail buffers
 * with lazy spill files, applies timeouts, and reports completions through
 * a single rebinding `onExit` hook (see ADR-0003 for the wake contract).
 *
 * The shared instance lives on globalThis via a Symbol.for key so it survives
 * extension reloads (jiti re-evaluates modules; globalThis does not). The
 * entry point rebinds `onExit` on every load — completions after a reload
 * route to the fresh runtime instead of vanishing (docs/PITFALLS.md P1).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export interface StartParams {
	command: string;
	cwd?: string;
	/** Kill the task after this many milliseconds. 0 disables the timeout. */
	timeoutMs?: number;
	env?: Record<string, string>;
	label?: string;
}

export interface TaskSnapshot {
	id: number;
	label: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	status: TaskStatus;
	exitCode: number | null;
	signal: string | null;
	errorMessage: string | undefined;
	startedAt: number;
	finishedAt: number | undefined;
	durationMs: number | undefined;
	timeoutMs: number;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	stdoutSpillPath: string | undefined;
	stderrSpillPath: string | undefined;
}

export interface TaskOutput {
	stdoutTail: string;
	stderrTail: string;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	stdoutSpillPath: string | undefined;
	stderrSpillPath: string | undefined;
}

/**
 * Bounded output buffer: keeps a byte tail in memory; on first overflow,
 * dumps everything captured so far into a spill file and appends every later
 * chunk there. Spill + memory tail always reconstruct the full output.
 */
export class OutputBuffer {
	private chunks: Buffer[] = [];
	private memBytes = 0;
	private totalBytes = 0;
	private spill: string | undefined;
	private readonly maxBytes: number;
	private readonly spillFilePath: string;

	constructor(maxBytes: number, spillFilePath: string) {
		this.maxBytes = maxBytes;
		this.spillFilePath = spillFilePath;
	}

	get byteLength(): number {
		return this.totalBytes;
	}

	get truncated(): boolean {
		return this.spill !== undefined;
	}

	get spillPath(): string | undefined {
		return this.spill;
	}

	append(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.totalBytes += chunk.length;
		if (this.spill !== undefined) {
			try {
				appendFileSync(this.spill, chunk);
			} catch {
				// Spill write failures must never kill the child pipeline;
				// the memory tail still carries the recent output.
			}
		}
		this.chunks.push(chunk);
		this.memBytes += chunk.length;
		if (this.spill === undefined && this.memBytes > this.maxBytes) {
			try {
				writeFileSync(this.spillFilePath, Buffer.concat(this.chunks));
				this.spill = this.spillFilePath;
			} catch {
				// No spill possible (disk full, tmp gone): keep trimming memory.
			}
		}
		if (this.spill !== undefined) {
			while (this.chunks.length > 1 && this.memBytes - this.chunks[0].length >= this.maxBytes) {
				this.memBytes -= this.chunks[0].length;
				this.chunks.shift();
			}
		}
	}

	/** Last `bytes` bytes decoded as UTF-8 (lossy on multi-byte boundaries). */
	tail(bytes: number): string {
		if (this.chunks.length === 0) return "";
		let take = Math.max(0, Math.min(bytes, this.memBytes));
		const parts: Buffer[] = [];
		for (let i = this.chunks.length - 1; i >= 0 && take > 0; i--) {
			const chunk = this.chunks[i];
			const slice = chunk.length > take ? chunk.subarray(chunk.length - take) : chunk;
			parts.unshift(slice);
			take -= slice.length;
		}
		return Buffer.concat(parts).toString("utf8");
	}

	dispose(): void {
		if (this.spill !== undefined) {
			try {
				rmSync(this.spill, { force: true });
			} catch {
				// Best effort only.
			}
		}
	}
}

export interface RegistryOptions {
	/** Per-stream in-memory tail limit. Default 1 MiB. */
	maxBufferBytes?: number;
	/** Default wall-clock limit per task. Default 10 minutes. */
	defaultTimeoutMs?: number;
	/** Grace period between SIGTERM and SIGKILL on timeout. Default 5 s. */
	killGraceMs?: number;
	/** Finished tasks retained for bg_status. Older ones are evicted. Default 50. */
	retainFinished?: number;
	/** Injectable for tests. */
	spawnFn?: typeof spawn;
	now?: () => number;
}

interface TaskInternal {
	snapshot: TaskSnapshot;
	child: ChildProcess | undefined;
	stdout: OutputBuffer;
	stderr: OutputBuffer;
	timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	killedByUser: boolean;
	timedOut: boolean;
	finalized: boolean;
}

export class TaskRegistry {
	private readonly tasks = new Map<string, TaskInternal>();
	private readonly order: TaskInternal[] = [];
	private nextId = 1;
	private spillDir: string | undefined;
	private disposed = false;
	private readonly options: RegistryOptions;

	public onExit: ((snapshot: TaskSnapshot, output: TaskOutput) => void) | undefined;

	constructor(options: RegistryOptions = {}) {
		this.options = options;
	}

	private get maxBufferBytes(): number {
		return this.options.maxBufferBytes ?? 1024 * 1024;
	}

	private get defaultTimeoutMs(): number {
		return this.options.defaultTimeoutMs ?? 10 * 60 * 1000;
	}

	private get killGraceMs(): number {
		return this.options.killGraceMs ?? 5000;
	}

	private get retainFinished(): number {
		return this.options.retainFinished ?? 50;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private ensureSpillDir(): string {
		if (this.spillDir === undefined) {
			this.spillDir = mkdtempSync(join(tmpdir(), "pi-bg-shell-"));
		} else {
			try {
				mkdirSync(this.spillDir, { recursive: true });
			} catch {
				// Already exists.
			}
		}
		return this.spillDir;
	}

	start(params: StartParams): TaskSnapshot {
		if (this.disposed) throw new Error("TaskRegistry is disposed");
		const command = params.command?.trim();
		if (!command) throw new Error("command must be a non-empty string");
		const timeoutMs = Math.max(0, params.timeoutMs ?? this.defaultTimeoutMs);
		const cwd = params.cwd?.trim() || process.cwd();
		const label = params.label?.trim() || command.slice(0, 60);

		const id = this.nextId++;
		const dir = this.ensureSpillDir();
		const spawnFn = this.options.spawnFn ?? spawn;
		const env = { ...process.env, ...(params.env ?? {}) };

		const task: TaskInternal = {
			snapshot: {
				id,
				label,
				command,
				cwd,
				pid: undefined,
				status: "running",
				exitCode: null,
				signal: null,
				errorMessage: undefined,
				startedAt: this.now(),
				finishedAt: undefined,
				durationMs: undefined,
				timeoutMs,
				stdoutBytes: 0,
				stderrBytes: 0,
				stdoutTruncated: false,
				stderrTruncated: false,
				stdoutSpillPath: undefined,
				stderrSpillPath: undefined,
			},
			child: undefined,
			stdout: new OutputBuffer(this.maxBufferBytes, join(dir, `${id}.stdout.log`)),
			stderr: new OutputBuffer(this.maxBufferBytes, join(dir, `${id}.stderr.log`)),
			timeoutTimer: undefined,
			killTimer: undefined,
			killedByUser: false,
			timedOut: false,
			finalized: false,
		};
		this.tasks.set(String(id), task);
		this.order.push(task);

		let child: ChildProcess;
		try {
			child = spawnFn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			task.snapshot.errorMessage = String(error);
			this.finalize(task, null, null);
			return { ...task.snapshot };
		}
		task.child = child;
		task.snapshot.pid = child.pid;

		child.stdout?.on("data", (chunk: Buffer) => {
			task.stdout.append(chunk);
			task.snapshot.stdoutBytes = task.stdout.byteLength;
			task.snapshot.stdoutTruncated = task.stdout.truncated;
			task.snapshot.stdoutSpillPath = task.stdout.spillPath;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			task.stderr.append(chunk);
			task.snapshot.stderrBytes = task.stderr.byteLength;
			task.snapshot.stderrTruncated = task.stderr.truncated;
			task.snapshot.stderrSpillPath = task.stderr.spillPath;
		});
		child.on("error", (error: Error) => {
			// spawn failures (missing cwd, fork limits) surface here; when the
			// child never spawned, 'close' may never fire — finalize directly.
			if (task.snapshot.errorMessage === undefined) task.snapshot.errorMessage = error.message;
			if (task.snapshot.pid === undefined) this.finalize(task, null, null);
		});
		child.on("close", (code, signal) => {
			this.finalize(task, code, signal);
		});

		if (timeoutMs > 0) {
			task.timeoutTimer = setTimeout(() => {
				task.timedOut = true;
				this.signalChild(task, "SIGTERM");
				task.killTimer = setTimeout(() => this.signalChild(task, "SIGKILL"), this.killGraceMs);
			}, timeoutMs);
		}
		this.evictFinished();
		return { ...task.snapshot };
	}

	private signalChild(task: TaskInternal, signal: NodeJS.Signals): void {
		try {
			task.child?.kill(signal);
		} catch {
			// Process already gone.
		}
	}

	private finalize(task: TaskInternal, code: number | null, signal: string | null): void {
		if (task.finalized) return;
		task.finalized = true;
		if (task.timeoutTimer !== undefined) clearTimeout(task.timeoutTimer);
		if (task.killTimer !== undefined) clearTimeout(task.killTimer);
		const snapshot = task.snapshot;
		snapshot.exitCode = code;
		snapshot.signal = signal;
		snapshot.finishedAt = this.now();
		snapshot.durationMs = snapshot.finishedAt - snapshot.startedAt;
		snapshot.status = task.killedByUser
			? "killed"
			: task.timedOut
				? "timeout"
				: snapshot.errorMessage !== undefined || (code === null && signal === null) || code !== 0
					? "failed"
					: "completed";
		try {
			this.onExit?.({ ...snapshot }, this.outputFor(task));
		} catch {
			// A broken notifier must not break process teardown.
		}
		this.evictFinished();
	}

	/** Snapshot of one task, or every task when id is omitted. */
	status(id?: number): TaskSnapshot[] {
		if (id !== undefined) {
			const task = this.tasks.get(String(id));
			return task ? [{ ...task.snapshot }] : [];
		}
		return this.order.map((task) => ({ ...task.snapshot }));
	}

	private outputFor(task: TaskInternal): TaskOutput {
		return {
			stdoutTail: task.stdout.tail(64 * 1024),
			stderrTail: task.stderr.tail(64 * 1024),
			stdoutBytes: task.stdout.byteLength,
			stderrBytes: task.stderr.byteLength,
			stdoutTruncated: task.stdout.truncated,
			stderrTruncated: task.stderr.truncated,
			stdoutSpillPath: task.stdout.spillPath,
			stderrSpillPath: task.stderr.spillPath,
		};
	}

	output(id: number, tailBytes?: number): TaskOutput | undefined {
		const task = this.tasks.get(String(id));
		if (!task) return undefined;
		const tail = tailBytes ?? 64 * 1024;
		return {
			stdoutTail: task.stdout.tail(tail),
			stderrTail: task.stderr.tail(tail),
			stdoutBytes: task.stdout.byteLength,
			stderrBytes: task.stderr.byteLength,
			stdoutTruncated: task.stdout.truncated,
			stderrTruncated: task.stderr.truncated,
			stdoutSpillPath: task.stdout.spillPath,
			stderrSpillPath: task.stderr.spillPath,
		};
	}

	kill(id: number, signal: NodeJS.Signals = "SIGTERM"): TaskSnapshot | undefined {
		const task = this.tasks.get(String(id));
		if (!task || task.finalized) return task ? { ...task.snapshot } : undefined;
		task.killedByUser = true;
		this.signalChild(task, signal);
		return { ...task.snapshot };
	}

	killAll(signal: NodeJS.Signals = "SIGTERM"): void {
		for (const task of this.tasks.values()) {
			if (!task.finalized) {
				task.killedByUser = true;
				this.signalChild(task, signal);
			}
		}
	}

	get runningCount(): number {
		let count = 0;
		for (const task of this.tasks.values()) if (!task.finalized) count++;
		return count;
	}

	private evictFinished(): void {
		let finished = this.order.filter((task) => task.finalized);
		while (finished.length > this.retainFinished) {
			const oldest = finished.shift();
			if (!oldest) break;
			this.tasks.delete(String(oldest.snapshot.id));
			const index = this.order.indexOf(oldest);
			if (index >= 0) this.order.splice(index, 1);
			oldest.stdout.dispose();
			oldest.stderr.dispose();
		}
	}

	/** Drop all tracked state and delete spill files. Running children get SIGTERM first. */
	dispose(): void {
		this.disposed = true;
		this.killAll("SIGTERM");
		for (const task of this.tasks.values()) {
			if (!task.finalized) {
				// Children that ignore SIGTERM still hold fds into the spill
				// dir; SIGKILL after the standard grace period is overkill at
				// quit time — the OS reaps them with pi's process group.
				this.signalChild(task, "SIGKILL");
			}
			task.stdout.dispose();
			task.stderr.dispose();
		}
		this.tasks.clear();
		this.order.length = 0;
		if (this.spillDir !== undefined) {
			try {
				rmSync(this.spillDir, { recursive: true, force: true });
			} catch {
				// Best effort only.
			}
			this.spillDir = undefined;
		}
		if (globalStore[registrySymbol] === this) {
			delete globalStore[registrySymbol];
		}
	}
}

const registrySymbol = Symbol.for("pi-bg-shell.registry.v1");
const globalStore = globalThis as { [registrySymbol]?: TaskRegistry };

/**
 * Process-wide registry shared across extension reloads. A reload swaps the
 * extension runtime (new module instance) but keeps this object — running
 * children and their buffers keep working, and the fresh entry point rebinds
 * `onExit` so completions still reach the agent.
 */
export function getSharedRegistry(): TaskRegistry {
	if (globalStore[registrySymbol] === undefined) {
		globalStore[registrySymbol] = new TaskRegistry();
	}
	return globalStore[registrySymbol];
}
