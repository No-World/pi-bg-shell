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
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export type TaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

/** Literal-substring watch over completed output lines (ADR-0005). */
export interface PatternSpec {
	/** Literal substring to match against each completed output line. */
	literal: string;
	/** Fire on every matching line instead of only the first. */
	all?: boolean;
	/** After delivering a match, stop the task (SIGTERM path). */
	stop?: boolean;
	/** Minimum gap between fires in `all` mode. Test knob; default 10 s. */
	minFireIntervalMs?: number;
}

/** Live state of an armed pattern, surfaced on every snapshot. */
export interface PatternState {
	literal: string;
	matches: number;
	lastLine: string;
	lastAt: number;
	lastStream: "stdout" | "stderr";
}

/** A delivery-time event about a still-running task (ADR-0005). */
export interface RunningEvent {
	kind: "pattern" | "report";
	stream?: "stdout" | "stderr";
	line?: string;
	matches?: number;
}

export interface StartParams {
	command: string;
	cwd?: string;
	/** Kill the task after this many milliseconds. 0 disables the timeout. */
	timeoutMs?: number;
	env?: Record<string, string>;
	label?: string;
	/** Wake the agent when an output line matches (task keeps running unless stop). */
	pattern?: PatternSpec;
	/** While running, deliver a progress report every this many ms. */
	reportEveryMs?: number;
	/** Detached: survive pi quitting, output to files, re-adopted next session (ADR-0006). */
	detach?: boolean;
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
	/** Armed pattern state; undefined when no pattern was given. */
	pattern: PatternState | undefined;
	/** Progress-report interval while running; undefined when off. */
	reportEveryMs: number | undefined;
	/** Detached: survives pi quitting, output in files (ADR-0006). */
	detached: boolean;
	/** Adopted from a previous session's manifest. */
	adopted: boolean;
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
 *
 * Spill files live inside a per-registry mkdtemp'd 0700 directory and are
 * created exclusively (O_EXCL "wx") with owner-only mode 0600 — no window
 * for symlink/pre-creation games in the shared tmpdir. If the spill cannot
 * be created or written (disk full, tmp gone), memory falls back to a bounded
 * tail and `truncated` still reports data loss.
 */
export class OutputBuffer {
	private chunks: Buffer[] = [];
	private memBytes = 0;
	private totalBytes = 0;
	private spill: string | undefined;
	private spillFd: number | undefined;
	private lossy = false;
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
		return this.spill !== undefined || this.lossy;
	}

	get spillPath(): string | undefined {
		return this.spill;
	}

	append(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.totalBytes += chunk.length;
		if (this.spillFd !== undefined) {
			try {
				writeSync(this.spillFd, chunk);
			} catch {
				// Spill write failures must never kill the child pipeline;
				// the memory tail still carries the recent output.
				this.lossy = true;
			}
		}
		this.chunks.push(chunk);
		this.memBytes += chunk.length;
		if (this.spillFd === undefined && this.memBytes > this.maxBytes) {
			this.openSpill();
		}
		if (this.memBytes > this.maxBytes && (this.spillFd !== undefined || this.lossy)) {
			while (this.chunks.length > 1 && this.memBytes - this.chunks[0].length >= this.maxBytes) {
				this.memBytes -= this.chunks[0].length;
				if (this.spillFd === undefined) this.lossy = true;
				this.chunks.shift();
			}
		}
	}

	private openSpill(): void {
		try {
			const fd = openSync(this.spillFilePath, "wx", 0o600);
			try {
				writeSync(fd, Buffer.concat(this.chunks));
			} catch (error) {
				closeSync(fd);
				throw error;
			}
			this.spillFd = fd;
			this.spill = this.spillFilePath;
		} catch {
			// No spill possible (disk full, tmp gone, leftover file): fall back
			// to a bounded lossy memory tail instead of growing unbounded.
			this.lossy = true;
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
		if (this.spillFd !== undefined) {
			try {
				closeSync(this.spillFd);
			} catch {
				// Best effort only.
			} finally {
				this.spillFd = undefined;
			}
		}
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
	/** Poll interval for adopted detached tasks and detached pattern feeding. Default 2 s. */
	adoptPollMs?: number;
	/** Root dir for detached manifests/output. Default: tmpdir()/pi-bg-shell. Test seam. */
	detachedDirPath?: string;
	/** Injectable for tests. */
	spawnFn?: typeof spawn;
	now?: () => number;
}

/** Very long unterminated lines are still tested once they pass this cap. */
const MAX_PENDING_LINE_CHARS = 64 * 1024;

/**
 * Splits streamed bytes into completed lines and tests each against a
 * literal substring, grep-style. Pending partial lines are buffered per
 * stream; a line longer than the cap is tested mid-flight so a match on an
 * unterminated firehose is not deferred forever.
 */
export class LineMatcher {
	private readonly pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
	private readonly literal: string;
	private readonly sink: (line: string, stream: "stdout" | "stderr") => void;

	constructor(literal: string, sink: (line: string, stream: "stdout" | "stderr") => void) {
		this.literal = literal;
		this.sink = sink;
	}

	feed(chunk: Buffer, stream: "stdout" | "stderr"): void {
		if (chunk.length === 0) return;
		const text = this.pending[stream] + chunk.toString("utf8");
		const parts = text.split("\n");
		this.pending[stream] = parts.pop() ?? "";
		for (const part of parts) this.test(part, stream);
		if (this.pending[stream].length > MAX_PENDING_LINE_CHARS) {
			const overflow = this.pending[stream];
			this.pending[stream] = "";
			this.test(overflow, stream);
		}
	}

	private test(line: string, stream: "stdout" | "stderr"): void {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.includes(this.literal)) this.sink(line, stream);
	}
}

/** Cross-session manifest for one detached task (ADR-0006). */
export interface DetachedManifest {
	version: 1;
	pid: number;
	command: string;
	label: string;
	cwd: string;
	startedAt: number;
	hostname: string;
	stdoutPath: string;
	stderrPath: string;
	statusPath: string;
	pattern: { literal: string; all: boolean; fired: boolean } | undefined;
}

/** Root dir for detached manifests/output; shared across sessions (ADR-0006). */
function detachedDirRoot(): string {
	return join(tmpdir(), "pi-bg-shell");
}

function ensureDir(root: string): string {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	// A pre-existing root must be a real directory owned by us: a hostile
	// local user pre-creating it (or symlinking it somewhere) must fail
	// loudly here instead of feeding us entries we cannot trust. This guard
	// backs the two codeql[js/insecure-temporary-file] suppressions below.
	try {
		const info = lstatSync(root);
		const uid = process.getuid?.();
		if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
			throw new Error(`pi-bg-shell: refusing insecure detached dir ${root}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return root;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function statSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Exit code recorded by the detached wrapper's trailing printf; null = none yet. */
function readExitCodeFile(path: string): number | null {
	try {
		const text = readFileSync(path, "utf8").trim();
		if (text === "") return null;
		const code = Number(text.split("\n").at(-1));
		return Number.isInteger(code) ? code : null;
	} catch {
		return null;
	}
}

function readManifest(path: string): DetachedManifest | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const manifest = parsed as Partial<DetachedManifest>;
		if (
			manifest.version !== 1 ||
			typeof manifest.pid !== "number" ||
			typeof manifest.command !== "string" ||
			typeof manifest.label !== "string" ||
			typeof manifest.cwd !== "string" ||
			typeof manifest.startedAt !== "number" ||
			typeof manifest.hostname !== "string" ||
			typeof manifest.stdoutPath !== "string" ||
			typeof manifest.stderrPath !== "string" ||
			typeof manifest.statusPath !== "string"
		) {
			return undefined;
		}
		if (
			manifest.pattern !== undefined &&
			(typeof manifest.pattern.literal !== "string" ||
				typeof manifest.pattern.all !== "boolean" ||
				typeof manifest.pattern.fired !== "boolean")
		) {
			return undefined;
		}
		return manifest as DetachedManifest;
	} catch {
		return undefined;
	}
}

/**
 * Read-side tail over a detached task's output file. The file IS the full
 * history (the child writes it directly), so `truncated` is true whenever
 * the file exists and `spillPath` is the file itself. dispose() removes the
 * file — quitting keeps running detached tasks out of dispose's path.
 */
export class FileTailSource {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	get byteLength(): number {
		try {
			return statSync(this.path).size;
		} catch {
			return 0;
		}
	}

	get truncated(): boolean {
		return existsSync(this.path);
	}

	get spillPath(): string | undefined {
		return existsSync(this.path) ? this.path : undefined;
	}

	tail(bytes: number): string {
		let fd: number;
		try {
				// Token-randomized name inside our 0700, uid-checked dir (see ensureDir).
				// codeql[js/insecure-temporary-file]
				fd = openSync(this.path, "r");
		} catch {
			return "";
		}
		try {
			// Size comes from the opened fd itself: stat-then-open would be a
			// TOCTOU race with the detached child appending to this very file.
			const size = fstatSync(fd).size;
			const take = Math.max(0, Math.min(bytes, size));
			if (take === 0) return "";
			const buffer = Buffer.alloc(take);
			readSync(fd, buffer, 0, take, size - take);
			return buffer.toString("utf8");
		} catch {
			return "";
		} finally {
			closeSync(fd);
		}
	}

	append(_chunk: Buffer): void {
		// The detached child writes the file itself; the registry never appends.
	}

	dispose(): void {
		try {
			rmSync(this.path, { force: true });
		} catch {
			// Best effort only.
		}
	}
}

/** Env var overriding the default task timeout. Read once at load (ADR-0004). */
export const DEFAULT_TIMEOUT_ENV = "PI_BG_SHELL_TIMEOUT_SEC";

/**
 * Parse PI_BG_SHELL_TIMEOUT_SEC into a default timeout in ms. Missing, empty,
 * non-finite, or negative values fall back to the given default; 0 disables
 * the default timeout entirely (per-task timeout_sec still applies).
 */
export function defaultTimeoutMsFromEnv(
	env: Record<string, string | undefined> = process.env,
	fallbackMs: number = 10 * 60 * 1000,
): number {
	const raw = env[DEFAULT_TIMEOUT_ENV]?.trim();
	if (raw === undefined || raw === "") return fallbackMs;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
	return seconds * 1000;
}

interface TaskInternal {
	snapshot: TaskSnapshot;
	child: ChildProcess | undefined;
	stdout: OutputBuffer | FileTailSource;
	stderr: OutputBuffer | FileTailSource;
	timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	killTimer: ReturnType<typeof setTimeout> | undefined;
	reportTimer: ReturnType<typeof setInterval> | undefined;
	patternCtl: {
		spec: PatternSpec;
		matcher: LineMatcher;
		fired: boolean;
		lastFireAt: number;
	} | undefined;
	detachedPaths: {
		manifestPath: string;
		stdoutPath: string;
		stderrPath: string;
		statusPath: string;
		/** Held-open fd for owned detached tasks; manifest updates go through it (exclusively created, 0600). */
		manifestFd: number | undefined;
	} | undefined;
	adopted: boolean;
	fileOffsets: { stdout: number; stderr: number } | undefined;
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

	/** Delivery-time events about still-running tasks (ADR-0005); rebound per load like onExit. */
	public onRunningEvent: ((snapshot: TaskSnapshot, output: TaskOutput, event: RunningEvent) => void) | undefined;

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

	private detachedRoot(): string {
		return ensureDir(this.options.detachedDirPath ?? detachedDirRoot());
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
		const detach = params.detach === true;
		// Detached tasks exist to outlive sessions; a default timeout that kills
		// them after 10 minutes would defeat the point (ADR-0006).
		const timeoutMs = Math.max(0, params.timeoutMs ?? (detach ? 0 : this.defaultTimeoutMs));
		const cwd = params.cwd?.trim() || process.cwd();
		const label = params.label?.trim() || command.slice(0, 60);
		if (params.pattern !== undefined && !params.pattern.literal) {
			throw new Error("pattern.literal must be a non-empty string");
		}
		const reportEveryMs = params.reportEveryMs !== undefined ? Math.max(0, params.reportEveryMs) : undefined;
		const patternState: PatternState | undefined = params.pattern
			? { literal: params.pattern.literal, matches: 0, lastLine: "", lastAt: 0, lastStream: "stdout" }
			: undefined;

		const id = this.nextId++;
		const dir = this.ensureSpillDir();
		const spawnFn = this.options.spawnFn ?? spawn;
		const env = { ...process.env, ...(params.env ?? {}) };

		// Detached artifacts: output files + exit-status file + manifest (ADR-0006).
		let detachedPaths: TaskInternal["detachedPaths"];
		let manifest: DetachedManifest | undefined;
		let outFd: number | undefined;
		let errFd: number | undefined;
		if (detach) {
			const ddir = this.detachedRoot();
			const token = `${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
			const stdoutPath = join(ddir, `${token}.stdout.log`);
			const stderrPath = join(ddir, `${token}.stderr.log`);
			const statusPath = join(ddir, `${token}.exit`);
			const manifestPath = join(ddir, `${token}.json`);
			manifest = {
				version: 1,
				pid: 0, // replaced after spawn
				command,
				label,
				cwd,
				startedAt: this.now(),
				hostname: hostname(),
				stdoutPath,
				stderrPath,
				statusPath,
				pattern: params.pattern
					? { literal: params.pattern.literal, all: params.pattern.all ?? false, fired: false }
					: undefined,
			};
			outFd = openSync(stdoutPath, "wx", 0o600);
			try {
				errFd = openSync(stderrPath, "wx", 0o600);
			} catch (error) {
				closeSync(outFd);
				throw error;
			}
			// Exclusive creation ("wx") + 0600: predictable tmpdir names are only
			// safe when creation refuses to follow pre-existing files/symlinks —
			// a bare writeFileSync with a mode would still be flagged (CodeQL
			// js/insecure-temporary-file). Updates go through the held-open fd.
			const manifestFd = openSync(manifestPath, "wx", 0o600);
			writeSync(manifestFd, JSON.stringify(manifest, null, "\t"));
			detachedPaths = { manifestPath, stdoutPath, stderrPath, statusPath, manifestFd };
		}

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
				pattern: patternState,
				reportEveryMs,
				detached: detach,
				adopted: false,
				stdoutBytes: 0,
				stderrBytes: 0,
				stdoutTruncated: false,
				stderrTruncated: false,
				stdoutSpillPath: undefined,
				stderrSpillPath: undefined,
			},
			child: undefined,
			stdout: detach && detachedPaths ? new FileTailSource(detachedPaths.stdoutPath) : new OutputBuffer(this.maxBufferBytes, join(dir, `${id}.stdout.log`)),
			stderr: detach && detachedPaths ? new FileTailSource(detachedPaths.stderrPath) : new OutputBuffer(this.maxBufferBytes, join(dir, `${id}.stderr.log`)),
			timeoutTimer: undefined,
			killTimer: undefined,
			reportTimer: undefined,
			patternCtl: undefined,
			detachedPaths: detach ? detachedPaths : undefined,
			adopted: false,
			fileOffsets: undefined,
			killedByUser: false,
			timedOut: false,
			finalized: false,
		};
		this.tasks.set(String(id), task);
		this.order.push(task);

		let child: ChildProcess;
		try {
			if (detach && detachedPaths && outFd !== undefined && errFd !== undefined) {
				// The wrapper records the command's real exit code — the wrapper
				// bash itself always exits 0 after its printf (ADR-0006).
				const wrapped =
					`( ${command}\n)\nprintf '%s\\n' "$?" > ${shellSingleQuote(detachedPaths.statusPath)}`;
				child = spawnFn("bash", ["-c", wrapped], {
					cwd,
					env,
					detached: true, // setsid: new process group, survives pi
					stdio: ["ignore", outFd, errFd],
				});
			} else {
				child = spawnFn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
			}
		} catch (error) {
			task.snapshot.errorMessage = String(error);
			this.finalize(task, null, null);
			return { ...task.snapshot };
		}
		task.child = child;
		task.snapshot.pid = child.pid;
		if (manifest !== undefined && child.pid !== undefined && detachedPaths !== undefined) {
			manifest.pid = child.pid;
			this.rewriteManifest(detachedPaths, manifest);
		}
		if (params.pattern !== undefined) {
			const spec = params.pattern;
			task.patternCtl = {
				spec,
				matcher: new LineMatcher(spec.literal, (line, stream) => this.handlePatternMatch(task, line, stream)),
				fired: false,
				lastFireAt: 0,
			};
		}

		child.on("error", (error: Error) => {
			// spawn failures (missing cwd, fork limits) surface here; when the
			// child never spawned, 'close' may never fire — finalize directly.
			if (task.snapshot.errorMessage === undefined) task.snapshot.errorMessage = error.message;
			if (task.snapshot.pid === undefined) this.finalize(task, null, null);
		});
		if (detach) {
			child.unref();
			if (outFd !== undefined) closeSync(outFd);
			if (errFd !== undefined) closeSync(errFd);
			// No pipes: the close event on our handle detects exit; the real
			// exit code comes from the status file (the wrapper's own exit is 0).
			child.on("close", (_code, signal) => this.finalizeDetached(task, signal));
			if (task.patternCtl !== undefined) this.ensureDetachedPoll();
		} else {
			child.stdout?.on("data", (chunk: Buffer) => {
				(task.stdout as OutputBuffer).append(chunk);
				task.snapshot.stdoutBytes = task.stdout.byteLength;
				task.snapshot.stdoutTruncated = task.stdout.truncated;
				task.snapshot.stdoutSpillPath = task.stdout.spillPath;
				task.patternCtl?.matcher.feed(chunk, "stdout");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				(task.stderr as OutputBuffer).append(chunk);
				task.snapshot.stderrBytes = task.stderr.byteLength;
				task.snapshot.stderrTruncated = task.stderr.truncated;
				task.snapshot.stderrSpillPath = task.stderr.spillPath;
				task.patternCtl?.matcher.feed(chunk, "stderr");
			});
			child.on("close", (code, signal) => {
				this.finalize(task, code, signal);
			});
		}

		if (timeoutMs > 0) {
			task.timeoutTimer = setTimeout(() => {
				task.timedOut = true;
				this.signalChild(task, "SIGTERM");
				task.killTimer = setTimeout(() => this.signalChild(task, "SIGKILL"), this.killGraceMs);
			}, timeoutMs);
		}
		if (reportEveryMs !== undefined && reportEveryMs > 0) {
			task.reportTimer = setInterval(() => this.handleReport(task), reportEveryMs);
			task.reportTimer.unref?.();
		}
		this.evictFinished();
		return { ...task.snapshot };
	}

	private signalChild(task: TaskInternal, signal: NodeJS.Signals): void {
		try {
			if (task.detachedPaths !== undefined && task.snapshot.pid !== undefined) {
				// Detached children are process-group leaders (setsid); signaling
				// the group also reaches the wrapped command's descendants.
				process.kill(-task.snapshot.pid, signal);
			} else {
				task.child?.kill(signal);
			}
		} catch {
			// Process already gone.
		}
	}

	/** Finalize a detached task: the real exit code lives in the status file. */
	private finalizeDetached(task: TaskInternal, signal: string | null): void {
		if (task.finalized) return;
		const code = task.detachedPaths !== undefined ? readExitCodeFile(task.detachedPaths.statusPath) : null;
		this.finalize(task, code, code === null ? signal : null);
	}

	// --- Detached adoption (ADR-0006) -------------------------------------

	private detachedPollTimer: ReturnType<typeof setInterval> | undefined;

	private ensureDetachedPoll(): void {
		if (this.detachedPollTimer !== undefined || this.disposed) return;
		const interval = Math.max(50, this.options.adoptPollMs ?? 2000);
		this.detachedPollTimer = setInterval(() => this.pollDetached(), interval);
		this.detachedPollTimer.unref?.();
	}

	private stopDetachedPollIfIdle(): void {
		const busy = this.order.some(
			(task) => !task.finalized && (task.adopted || (task.detachedPaths !== undefined && task.patternCtl !== undefined)),
		);
		if (!busy && this.detachedPollTimer !== undefined) {
			clearInterval(this.detachedPollTimer);
			this.detachedPollTimer = undefined;
		}
	}

	private pollDetached(): void {
		for (const task of [...this.order]) {
			if (task.finalized || task.detachedPaths === undefined) continue;
			this.feedPatternFromFiles(task);
			if (task.adopted) {
				// Status file content is the authoritative death signal (PID reuse
				// cannot fake it); the pid check covers crashes before the printf.
				const status = readExitCodeFile(task.detachedPaths.statusPath);
				if (status !== null || !pidAlive(task.snapshot.pid)) {
					this.finalizeDetached(task, null);
				}
			}
		}
		this.stopDetachedPollIfIdle();
	}

	/** Feed the pattern matcher from file growth since the last poll. */
	private feedPatternFromFiles(task: TaskInternal): void {
		if (task.patternCtl === undefined || task.detachedPaths === undefined) return;
		if (task.fileOffsets === undefined) {
			task.fileOffsets = {
				stdout: statSize(task.detachedPaths.stdoutPath),
				stderr: statSize(task.detachedPaths.stderrPath),
			};
		}
		for (const stream of ["stdout", "stderr"] as const) {
			const path = stream === "stdout" ? task.detachedPaths.stdoutPath : task.detachedPaths.stderrPath;
			let fd: number;
			try {
				fd = openSync(path, "r");
			} catch {
				continue; // no output file (yet); the next poll retries
			}
			try {
				// Authoritative size from the fd: the detached child appends to
				// this file concurrently, so stat-then-read would race (CodeQL
				// js/race-condition); appends after fstat just shorten this read.
				const size = fstatSync(fd).size;
				if (size < task.fileOffsets[stream]) task.fileOffsets[stream] = 0; // truncated/rotated
				const delta = size - task.fileOffsets[stream];
				if (delta > 0) {
					const buffer = Buffer.alloc(delta);
					readSync(fd, buffer, 0, delta, task.fileOffsets[stream]);
					task.patternCtl.matcher.feed(buffer, stream);
					task.fileOffsets[stream] = size;
				}
			} catch {
				// Skip unreadable deltas; the next poll retries from the same offset.
			} finally {
				closeSync(fd);
			}
		}
	}

	/** Replay pre-adoption output for counting; optionally deliver one stale wake. */
	private replayPatternHistory(task: TaskInternal, emit: boolean): void {
		const ctl = task.patternCtl;
		const state = task.snapshot.pattern;
		if (!ctl || !state || task.detachedPaths === undefined) return;
		const realConsumer = this.onRunningEvent;
		if (!emit) this.onRunningEvent = undefined;
		for (const stream of ["stdout", "stderr"] as const) {
			const path = stream === "stdout" ? task.detachedPaths.stdoutPath : task.detachedPaths.stderrPath;
			try {
				const content = readFileSync(path, "utf8");
				if (content !== "") ctl.matcher.feed(Buffer.from(content, "utf8"), stream);
			} catch {
				// No output file yet.
			}
		}
		this.onRunningEvent = realConsumer;
		ctl.lastFireAt = this.now();
		if (emit && !ctl.fired && state.matches > 0) {
			// The single-shot event happened while nobody watched — deliver it
			// once, marked with the last matching line.
			ctl.fired = true;
			this.emitRunningEvent(task, {
				kind: "pattern",
				stream: state.lastStream,
				line: state.lastLine,
				matches: state.matches,
			});
			this.persistPatternFired(task);
		}
	}

	private persistPatternFired(task: TaskInternal): void {
		if (task.detachedPaths === undefined) return;
		const manifest = readManifest(task.detachedPaths.manifestPath);
		if (manifest?.pattern === undefined) return;
		manifest.pattern.fired = true;
		this.rewriteManifest(task.detachedPaths, manifest);
	}

	/**
	 * Update a manifest through the held-open fd (owned tasks) or an "r+"
	 * reopen (adopted tasks) — never a bare path write: predictable tmpdir
	 * names must not be written via writeFileSync, which follows symlinks
	 * (CodeQL js/insecure-temporary-file).
	 */
	private rewriteManifest(
		paths: NonNullable<TaskInternal["detachedPaths"]>,
		manifest: DetachedManifest,
	): void {
		const json = JSON.stringify(manifest, null, "\t");
		try {
			if (paths.manifestFd !== undefined) {
				ftruncateSync(paths.manifestFd, 0);
				writeSync(paths.manifestFd, json, 0);
			} else {
				// Inside our 0700, uid-checked dir; "r+" never creates.
				// codeql[js/insecure-temporary-file]
				const fd = openSync(paths.manifestPath, "r+");
				try {
					ftruncateSync(fd, 0);
					writeSync(fd, json, 0);
				} finally {
					closeSync(fd);
				}
			}
		} catch {
			// Best effort: a stale manifest only degrades a future adoption.
		}
	}

	/** Register a task from a previous session's manifest; returns its snapshot. */
	private registerAdopted(manifest: DetachedManifest, manifestPath: string, deadOnArrival: boolean): TaskSnapshot {
		const id = this.nextId++;
		const task: TaskInternal = {
			snapshot: {
				id,
				label: manifest.label,
				command: manifest.command,
				cwd: manifest.cwd,
				pid: manifest.pid,
				status: "running",
				exitCode: null,
				signal: null,
				errorMessage: undefined,
				startedAt: manifest.startedAt,
				finishedAt: undefined,
				durationMs: undefined,
				timeoutMs: 0,
				pattern:
					manifest.pattern !== undefined
						? { literal: manifest.pattern.literal, matches: 0, lastLine: "", lastAt: 0, lastStream: "stdout" }
						: undefined,
				reportEveryMs: undefined, // reports do not survive sessions; re-arm if needed
				detached: true,
				adopted: true,
				stdoutBytes: statSize(manifest.stdoutPath),
				stderrBytes: statSize(manifest.stderrPath),
				stdoutTruncated: existsSync(manifest.stdoutPath),
				stderrTruncated: existsSync(manifest.stderrPath),
				stdoutSpillPath: existsSync(manifest.stdoutPath) ? manifest.stdoutPath : undefined,
				stderrSpillPath: existsSync(manifest.stderrPath) ? manifest.stderrPath : undefined,
			},
			child: undefined,
			stdout: new FileTailSource(manifest.stdoutPath),
			stderr: new FileTailSource(manifest.stderrPath),
			timeoutTimer: undefined,
			killTimer: undefined,
			reportTimer: undefined,
			patternCtl: undefined,
			detachedPaths: {
				manifestPath,
				stdoutPath: manifest.stdoutPath,
				stderrPath: manifest.stderrPath,
				statusPath: manifest.statusPath,
				manifestFd: undefined, // adopted: updates reopen with "r+"
			},
			adopted: true,
			fileOffsets: { stdout: statSize(manifest.stdoutPath), stderr: statSize(manifest.stderrPath) },
			killedByUser: false,
			timedOut: false,
			finalized: false,
		};
		this.tasks.set(String(id), task);
		this.order.push(task);
		if (manifest.pattern !== undefined) {
			const spec: PatternSpec = { literal: manifest.pattern.literal, all: manifest.pattern.all };
			task.patternCtl = {
				spec,
				matcher: new LineMatcher(spec.literal, (line, stream) => this.handlePatternMatch(task, line, stream)),
				fired: manifest.pattern.fired,
				lastFireAt: this.now(),
			};
			this.replayPatternHistory(task, !deadOnArrival);
		}
		if (deadOnArrival) {
			// It died while no session watched: register the outcome silently.
			const consumer = this.onExit;
			this.onExit = undefined;
			this.finalizeDetached(task, null);
			this.onExit = consumer;
		} else {
			this.ensureDetachedPoll();
		}
		this.evictFinished();
		return { ...task.snapshot };
	}

	/** Scan the manifest dir and re-adopt tasks from previous sessions. */
	adoptDetached(): number {
		if (this.disposed) return 0;
		const root = this.detachedRoot();
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			return 0;
		}
		const known = new Set(
			this.order
				.map((task) => task.detachedPaths?.manifestPath)
				.filter((path): path is string => path !== undefined),
		);
		let adopted = 0;
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const manifestPath = join(root, name);
			if (known.has(manifestPath)) continue; // already tracked (post-reload)
			const manifest = readManifest(manifestPath);
			if (manifest === undefined) {
				try {
					rmSync(manifestPath, { force: true });
				} catch {
					// Junk file; ignore.
				}
				continue;
			}
			if (manifest.hostname !== hostname()) continue; // foreign tmp mount
			if (!pidAlive(manifest.pid)) {
				this.registerAdopted(manifest, manifestPath, true);
				continue;
			}
			this.registerAdopted(manifest, manifestPath, false);
			adopted += 1;
		}
		return adopted;
	}

	private removeManifest(task: TaskInternal): void {
		if (task.detachedPaths === undefined) return;
		if (task.detachedPaths.manifestFd !== undefined) {
			try {
				closeSync(task.detachedPaths.manifestFd);
			} catch {
				// Best effort only.
			}
			task.detachedPaths.manifestFd = undefined;
		}
		try {
			rmSync(task.detachedPaths.manifestPath, { force: true });
		} catch {
			// Best effort only.
		}
	}

	private handlePatternMatch(task: TaskInternal, line: string, stream: "stdout" | "stderr"): void {
		const ctl = task.patternCtl;
		const state = task.snapshot.pattern;
		if (!ctl || !state || task.finalized) return;
		state.matches += 1;
		state.lastLine = line;
		state.lastAt = this.now();
		state.lastStream = stream;
		const minInterval = Math.max(0, ctl.spec.minFireIntervalMs ?? 10_000);
		if (!ctl.spec.all) {
			if (ctl.fired) return; // single-shot: later matches still count, but never re-fire
			ctl.fired = true;
		} else if (state.matches > 1 && state.lastAt - ctl.lastFireAt < minInterval) {
			return; // rate-limited: log floods must not stampede the session
		}
		ctl.lastFireAt = state.lastAt;
		this.emitRunningEvent(task, { kind: "pattern", stream, line, matches: state.matches });
		if (task.detachedPaths !== undefined) this.persistPatternFired(task);
		if (ctl.spec.stop) {
			// Deliver first, then stop the task on the agent's instruction;
			// the normal kill path applies (killed status + completion notify).
			this.kill(task.snapshot.id, "SIGTERM");
		}
	}

	private handleReport(task: TaskInternal): void {
		if (task.finalized) return;
		this.emitRunningEvent(task, { kind: "report" });
	}

	private emitRunningEvent(task: TaskInternal, event: RunningEvent): void {
		const snapshot = { ...task.snapshot };
		if (task.snapshot.pattern !== undefined) snapshot.pattern = { ...task.snapshot.pattern };
		try {
			this.onRunningEvent?.(snapshot, this.outputFor(task), event);
		} catch {
			// A broken consumer must not break the output pipeline.
		}
	}

	private finalize(task: TaskInternal, code: number | null, signal: string | null): void {
		if (task.finalized) return;
		task.finalized = true;
		if (task.timeoutTimer !== undefined) clearTimeout(task.timeoutTimer);
		if (task.killTimer !== undefined) clearTimeout(task.killTimer);
		if (task.reportTimer !== undefined) clearInterval(task.reportTimer);
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
			// Detached tasks outlive the session on purpose — quitting never
			// signals them (ADR-0006).
			if (!task.finalized && task.detachedPaths === undefined) {
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
			if (oldest.detachedPaths !== undefined) this.removeManifest(oldest);
		}
	}

	/** Drop all tracked state and delete spill files. Running detached tasks survive. */
	dispose(): void {
		this.disposed = true;
		if (this.detachedPollTimer !== undefined) {
			clearInterval(this.detachedPollTimer);
			this.detachedPollTimer = undefined;
		}
		this.killAll("SIGTERM");
		for (const task of this.tasks.values()) {
			if (task.reportTimer !== undefined) clearInterval(task.reportTimer);
			const detached = task.detachedPaths !== undefined;
			if (!task.finalized) {
				if (detached) {
					// Survivors keep files and keep running; close our manifest fd —
					// the JSON is already on disk, adoption reads it from there.
					if (task.detachedPaths?.manifestFd !== undefined) {
						try {
							closeSync(task.detachedPaths.manifestFd);
						} catch {
							// Best effort only.
						}
						task.detachedPaths.manifestFd = undefined;
					}
					continue;
				}
				// Children that ignore SIGTERM still hold fds into the spill
				// dir; SIGKILL after the standard grace period is overkill at
				// quit time — the OS reaps them with pi's process group.
				this.signalChild(task, "SIGKILL");
			}
			task.stdout.dispose();
			task.stderr.dispose();
			if (detached) this.removeManifest(task);
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
export function getSharedRegistry(options?: RegistryOptions): TaskRegistry {
	if (globalStore[registrySymbol] === undefined) {
		globalStore[registrySymbol] = new TaskRegistry(options);
	}
	return globalStore[registrySymbol];
}
