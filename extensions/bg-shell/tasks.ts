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
	realpathSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
	composeNormalCommand,
	composePwshDetachedCommand,
	PWSH_DETACHED_ENV,
	PWSH_DETACHED_INNER,
	resolveBashSpec,
	type ShellSpec,
} from "./shell.ts";

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

/** One scanned global-pool task (ADR-0007). */
interface PoolEntry {
	manifestPath: string;
	manifest: DetachedManifest;
	terminal: boolean;
	reported: boolean;
	liveSubscribers: number[];
}

/** A pool task this session does not track (bg_status foreign section / bg_adopt). */
export interface ForeignTaskInfo {
	manifestPath: string;
	label: string;
	command: string;
	pid: number;
	alive: boolean;
	sessionId: string | undefined;
	startedAt: number;
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
	/** Interpreter spec; defaults to native-parity bash resolution (ADR-0009). */
	shell?: ShellSpec;
}

export interface TaskSnapshot {
	id: number;
	label: string;
	command: string;
	/** Interpreter display name ("bash" | "pwsh"), ADR-0009. */
	shell: string;
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
	/** Terminal state was backfilled by the pool (nobody watched it die; ADR-0007). */
	unattended?: boolean;
	/** Who killed the task, from the cross-session attribution marker (ADR-0007). */
	killedBy?: string;
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
	/** Session identity for pool auto re-subscription. Default: PI_SESSION_ID. Test seam (ADR-0007). */
	sessionId?: string;
	/** Injectable for tests. */
	spawnFn?: typeof spawn;
	/** Default shell resolution for bare start() calls; real resolution mirrors pi native (ADR-0009). */
	resolveShell?: () => ShellSpec;
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
	/** Windows+WSL only: host-written wrapper script — keeps "$?" out of argv (PITFALLS P6). */
	wrapperPath?: string;
	/** Windows only: wscript launcher — the only popup-free detached spawn (PITFALLS P8). */
	launcherPath?: string;
	/** Interpreter family this task runs under; absent (legacy manifests) means bash (ADR-0009). */
	shell?: string;
	/** Owning pi process; a live foreign owner keeps its pool private (ADR-0006). */
	ownerPid?: number;
	/** Creating-session identity (PI_SESSION_ID); same-id sessions re-subscribe automatically (ADR-0007). */
	sessionId?: string;
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
	// backs the mkdtemp session dirs created inside it (see
	// ensureDetachedSessionDir).
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

/**
 * Translate a Windows drive path for a WSL-side shell ("C:\\a\\b" →
 * "/mnt/c/a/b"). Returns undefined for anything that is not a drive path
 * (UNC shares, POSIX paths) — callers must fail fast instead of handing
 * bash a path it cannot address (#15).
 */
export function toWslPath(path: string): string | undefined {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
	if (match === null) return undefined;
	return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/** Backslash → forward-slash Windows path ("C:\\a\\b" → "C:/a/b") — native to Git Bash, Cygwin, and MSYS2 alike. */
function toWindowsSlashPath(path: string): string {
	return path.replace(/\\/g, "/");
}

/**
 * Windows+WSL detached wrapper: WSL does not translate inherited Windows
 * file handles (an fd passed to spawn lands on the console), so the shell
 * itself redirects to /mnt/<drive>/ paths and stdio stays ignored. POSIX
 * keeps the fd fast path (ADR-0006).
 *
 * The returned string is written to a host-side script file and spawned as
 * `bash <file>` — never as `-c` argv: the WSL relay re-quotes arguments
 * through its default shell, which expands the double-quoted "$?" to a
 * literal 0 before the wrapper bash even parses it (PITFALLS P6).
 */
export function buildWslDetachedWrapper(
	command: string,
	redirects: { stdoutPath: string; stderrPath: string; statusPath: string },
): string {
	return (
		`( ${command}\n) >> ${shellSingleQuote(redirects.stdoutPath)}` +
		` 2>> ${shellSingleQuote(redirects.stderrPath)}` +
		`\nprintf '%s\\n' "$?" > ${shellSingleQuote(redirects.statusPath)}`
	);
}

/** Quote one token for a VBScript shell.Run line. */
export function vbsQuoted(value: string): string {
	return `Chr(34) & "${value}" & Chr(34)`;
}

/**
 * Popup-free hidden launcher (PITFALLS P8): wscript is a GUI-subsystem
 * binary, so it never owns a console — DETACHED_PROCESS has nothing to pop a
 * window for — and Run(..., 0, True) starts the payload hidden and waits,
 * keeping our child handle alive for the close event. A side benefit over a
 * detached console child: closing the hosting terminal cannot kill the tree
 * anymore, because there is no console to receive the close event.
 */
export function buildHiddenRunLauncher(runLine: string): string {
	return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run ${runLine}, 0, True\r\n`;
}

/**
 * Windows-native bash detached wrapper (Git Bash/Cygwin/MSYS2 — ADR-0009):
 * unlike the WSL relay these address C:/ paths directly, so no /mnt
 * translation — only backslashes become forward slashes. Same shape as the
 * WSL wrapper otherwise (exit code via the trailing printf, out of argv).
 */
export function buildWindowsBashDetachedWrapper(
	command: string,
	redirects: { stdoutPath: string; stderrPath: string; statusPath: string },
): string {
	return (
		`( ${command}\n) >> ${shellSingleQuote(toWindowsSlashPath(redirects.stdoutPath))}` +
		` 2>> ${shellSingleQuote(toWindowsSlashPath(redirects.stderrPath))}` +
		`\nprintf '%s\\n' "$?" > ${shellSingleQuote(toWindowsSlashPath(redirects.statusPath))}`
	);
}

/**
 * PowerShell detached wrapper, cmd flavor (ADR-0009). wscript runs this
 * hidden. cmd's 1>>/2>> are RAW byte appends — PowerShell's own >> writes
 * UTF-16LE+BOM on 5.1 (measured), which would poison UTF-8 tails and
 * on_pattern matching. The pwsh invocation is a FIXED string: the command
 * itself travels through PI_BG_SHELL_CMD, so no quoting anywhere on the
 * wscript → cmd → pwsh chain. The parenthesized (echo %ERRORLEVEL%) keeps
 * cmd from parsing a leading exit-code digit as a stream redirect.
 */
export function buildPwshDetachedWrapperCmd(
	bin: string,
	redirects: { stdoutPath: string; stderrPath: string; statusPath: string },
): string {
	return (
		`@echo off\r\n` +
		`"${bin}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${PWSH_DETACHED_INNER}"` +
		` 1>>"${redirects.stdoutPath}" 2>>"${redirects.stderrPath}"\r\n` +
		`(echo %ERRORLEVEL%)>"${redirects.statusPath}"\r\n` +
		`exit /b %ERRORLEVEL%\r\n`
	);
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

/** Adoption-side persistence of pattern.fired: <manifest>.json -> <manifest>.fired marker. */
function firedMarkerPath(manifestPath: string): string {
	return manifestPath.replace(/\.json$/, ".fired");
}

/** One subscriber's claim on a pool task: <manifest>.json -> <manifest>.sub.<pid> (ADR-0007). */
function subMarkerPath(manifestPath: string, pid: number): string {
	return manifestPath.replace(/\.json$/, `.sub.${pid}`);
}

/** Pool-level "terminal state already reported" idempotence marker (ADR-0007). */
function reportedMarkerPath(manifestPath: string): string {
	return manifestPath.replace(/\.json$/, ".reported");
}

/** Cross-session kill attribution written by the killing session (ADR-0007). */
function killedByMarkerPath(manifestPath: string): string {
	return manifestPath.replace(/\.json$/, ".killedby");
}

/** Exclusive marker creation (0600): EEXIST counts as already-there; best effort. */
function writeMarker(path: string, content = ""): boolean {
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			if (content !== "") writeSync(fd, content);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

function readMarker(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
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
		if (manifest.wrapperPath !== undefined && typeof manifest.wrapperPath !== "string") {
			return undefined;
		}
		if (manifest.launcherPath !== undefined && typeof manifest.launcherPath !== "string") {
			return undefined;
		}
		if (manifest.ownerPid !== undefined && typeof manifest.ownerPid !== "number") {
			return undefined;
		}
		if (manifest.sessionId !== undefined && typeof manifest.sessionId !== "string") {
			return undefined;
		}
		if (manifest.shell !== undefined && typeof manifest.shell !== "string") {
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
				// Randomized name inside a per-session mkdtemp dir under our 0700,
				// uid-checked root (see ensureDetachedSessionDir).
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
		/** Windows+WSL: wrapper script; removed together with the manifest. */
		wrapperPath?: string;
		/** Windows+WSL: wscript launcher; removed together with the manifest. */
		launcherPath?: string;
		/** Held-open fd for owned detached tasks; manifest updates go through it (exclusively created, 0600). */
		manifestFd: number | undefined;
	} | undefined;
	adopted: boolean;
	fileOffsets: { stdout: number; stderr: number } | undefined;
	killedByUser: boolean;
	timedOut: boolean;
	finalized: boolean;
	unattendedBackfill: boolean;
	unattendedFinishedAt: number | undefined;
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

	private detachedPollTimer: ReturnType<typeof setInterval> | undefined;
	private detachedSessionDir: string | undefined;
	private readonly sessionIdValue: string;

	constructor(options: RegistryOptions = {}) {
		this.options = options;
		this.sessionIdValue = (options.sessionId ?? process.env.PI_SESSION_ID ?? "").trim();
	}

	/** Our identity in the pool: the session id when one exists, else the pid. */
	private selfLabel(): string {
		return this.sessionIdValue !== "" ? this.sessionIdValue : `pid ${process.pid}`;
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

	/**
	 * Per-session mkdtemp subdir under the fixed root: paths inside a
	 * mkdtemp-created directory are trusted lineage (the same pattern that
	 * keeps spill files out of js/insecure-temporary-file), while the fixed
	 * root stays discoverable across sessions for adoption.
	 */
	private ensureDetachedSessionDir(): string {
		if (this.detachedSessionDir === undefined) {
			this.detachedSessionDir = mkdtempSync(join(this.detachedRoot(), "s-"));
		}
		return this.detachedSessionDir;
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

	/** Write a per-task hidden-launcher VBS; returns its path (PITFALLS P8, ADR-0009). */
	private writeHiddenLauncher(ddir: string, token: string, runLine: string): string {
		const launcherPath = join(ddir, `${token}.launcher.vbs`);
		const fd = openSync(launcherPath, "wx", 0o600);
		try {
				writeSync(fd, buildHiddenRunLauncher(runLine));
		} finally {
			closeSync(fd);
		}
		return launcherPath;
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
		const spec = params.shell ?? (this.options.resolveShell ?? resolveBashSpec)();
		const env = { ...process.env, ...(params.env ?? {}) };

		// Detached artifacts: output files + exit-status file + manifest (ADR-0006).
		let detachedPaths: TaskInternal["detachedPaths"];
		let manifest: DetachedManifest | undefined;
		let outFd: number | undefined;
		let errFd: number | undefined;
		if (detach) {
			const ddir = this.ensureDetachedSessionDir();
			const token = `${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
			const stdoutPath = join(ddir, `${token}.stdout.log`);
			const stderrPath = join(ddir, `${token}.stderr.log`);
			const statusPath = join(ddir, `${token}.exit`);
			const wrapperPath = join(ddir, `${token}.wrapper.${spec.flavor === "powershell" ? "cmd" : "sh"}`);
			const manifestPath = join(ddir, `${token}.json`);
			manifest = {
				version: 1,
				pid: 0, // replaced after spawn
				command,
				label,
				cwd,
				startedAt: this.now(),
				hostname: hostname(),
				shell: spec.name,
				ownerPid: process.pid,
				sessionId: this.sessionIdValue !== "" ? this.sessionIdValue : undefined,
				stdoutPath,
				stderrPath,
				statusPath,
				pattern: params.pattern
					? { literal: params.pattern.literal, all: params.pattern.all ?? false, fired: false }
					: undefined,
			};
			if (spec.flavor === "wsl-bash") {
				// WSL bash.exe cannot address Windows paths; fail fast before any
				// artifact exists rather than run a task whose output and exit
				// status can never be recorded (#15).
				for (const path of [stdoutPath, stderrPath, statusPath, wrapperPath]) {
					if (toWslPath(path) === undefined) {
						throw new Error(
							`detached WSL tasks need drive-letter paths for translation (got ${path})`,
						);
					}
				}
				// The wrapper must cross the WSL boundary as a FILE, never as -c
				// argv: the relay re-quotes arguments through its default shell,
				// which expands the double-quoted "$?" to a literal 0 before the
				// wrapper bash even parses it (PITFALLS P6).
				const wrapperFd = openSync(wrapperPath, "wx", 0o600);
				try {
					writeSync(
						wrapperFd,
						buildWslDetachedWrapper(command, {
							stdoutPath: toWslPath(stdoutPath) as string,
							stderrPath: toWslPath(stderrPath) as string,
							statusPath: toWslPath(statusPath) as string,
						}),
					);
				} finally {
					closeSync(wrapperFd);
				}
				manifest.wrapperPath = wrapperPath;
				manifest.launcherPath = this.writeHiddenLauncher(
					ddir,
					token,
					`${vbsQuoted(spec.bin)} & " " & ${vbsQuoted(toWslPath(wrapperPath) as string)}`,
				);
			} else if (spec.flavor === "windows-bash" || spec.flavor === "powershell") {
				// Native-Windows interpreters address C:\ paths directly — no
				// /mnt translation (ADR-0009). All win32 flavors still need the
				// GUI launcher: DETACHED_PROCESS pops a visible console for console
				// children regardless of windowsHide (PITFALLS P8).
				let wrapper: string;
				if (spec.flavor === "powershell") {
					wrapper = buildPwshDetachedWrapperCmd(spec.bin, { stdoutPath, stderrPath, statusPath });
					env[PWSH_DETACHED_ENV] = composePwshDetachedCommand(command);
				} else {
					wrapper = buildWindowsBashDetachedWrapper(command, { stdoutPath, stderrPath, statusPath });
				}
				const wrapperFd = openSync(wrapperPath, "wx", 0o600);
				try {
					writeSync(wrapperFd, wrapper);
				} finally {
					closeSync(wrapperFd);
				}
				manifest.wrapperPath = wrapperPath;
				const runLine =
					spec.flavor === "powershell"
						? `${vbsQuoted(env.ComSpec ?? "cmd.exe")} & " /c " & ${vbsQuoted(wrapperPath)}`
						: `${vbsQuoted(spec.bin)} & " " & ${vbsQuoted(wrapperPath)}`;
				manifest.launcherPath = this.writeHiddenLauncher(ddir, token, runLine);
			} else {
				outFd = openSync(stdoutPath, "wx", 0o600);
				try {
					errFd = openSync(stderrPath, "wx", 0o600);
				} catch (error) {
					closeSync(outFd);
					throw error;
				}
			}
			// Exclusive creation ("wx") + 0600: predictable tmpdir names are only
			// safe when creation refuses to follow pre-existing files/symlinks —
			// a bare writeFileSync with a mode would still be flagged (CodeQL
			// js/insecure-temporary-file). Updates go through the held-open fd.
			const manifestFd = openSync(manifestPath, "wx", 0o600);
			writeSync(manifestFd, JSON.stringify(manifest, null, "\t"));
			detachedPaths = {
				manifestPath,
				stdoutPath,
				stderrPath,
				statusPath,
				wrapperPath: manifest.wrapperPath,
				launcherPath: manifest.launcherPath,
				manifestFd,
			};
		}

		const task: TaskInternal = {
			snapshot: {
				id,
				label,
				command,
				shell: spec.name,
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
				unattended: false,
				killedBy: undefined,
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
			// Owned detached tasks watch their output files from byte 0: POSIX
			// files are exclusively created empty, Windows ones do not exist
			// until the relay child starts. Lazy init at the first poll would
			// permanently skip anything written before that tick (PITFALLS P7).
			fileOffsets: detach ? { stdout: 0, stderr: 0 } : undefined,
			killedByUser: false,
			timedOut: false,
			finalized: false,
			unattendedBackfill: false,
			unattendedFinishedAt: undefined,
		};
		this.tasks.set(String(id), task);
		this.order.push(task);

		let child: ChildProcess;
		try {
			if (detach && detachedPaths && spec.flavor !== "posix-bash") {
				// Paths were validated before any artifact was created, and the
				// launcher file was written in that same block, so the assertion is
				// structural only. wscript.exe is a GUI-subsystem binary: detached
				// cannot give it a console, so nothing pops a window, and its
				// Run(…, True) waits for the payload tree, keeping our close event
				// meaningful (PITFALLS P8).
				child = spawnFn("wscript.exe", ["//B", "//Nologo", detachedPaths.launcherPath as string], {
					cwd,
					env,
					detached: true,
					stdio: "ignore",
					windowsHide: true,
				});
			} else if (detach && detachedPaths && outFd !== undefined && errFd !== undefined) {
				// The wrapper records the command's real exit code — the wrapper
				// bash itself always exits 0 after its printf (ADR-0006).
				const wrapped =
					`( ${command}\n)\nprintf '%s\\n' "$?" > ${shellSingleQuote(detachedPaths.statusPath)}`;
				child = spawnFn(spec.bin, [...spec.args, wrapped], {
					cwd,
					env,
					detached: true, // setsid: new process group, survives pi
					stdio: ["ignore", outFd, errFd],
					windowsHide: true,
				});
			} else {
				// Native parity (ADR-0009): resolved interpreter + its fixed argv
				// prefix + the command; windowsHide keeps console-subsystem
				// children (WSL relay, Git Bash, pwsh) popup-free.
				child = spawnFn(spec.bin, [...spec.args, composeNormalCommand(spec, command)], {
					cwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
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
		const pid = task.snapshot.pid ?? task.child?.pid;
		if (pid === undefined) return;
		if (process.platform === "win32") {
			// Windows has no signal semantics across the WSL relay: Node's kill
			// terminates only the direct child (leaving the WSL side orphaned)
			// and POSIX process groups do not exist. taskkill /t walks the whole
			// relay tree instead; /f is the same TerminateProcess Node itself
			// would use — there is no graceful console kill to honor.
			const spawnFn = this.options.spawnFn ?? spawn;
			const killer = spawnFn("taskkill", ["/pid", String(pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => undefined);
			return;
		}
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
		if (task.detachedPaths.manifestFd !== undefined) {
			this.rewriteManifest(task.detachedPaths, manifest);
		} else {
			// Adopted task: no held fd, and a path-based reopen would follow
			// symlinks (CodeQL js/insecure-temporary-file). Persist via an
			// exclusive "wx" marker — the one creation pattern that refuses
			// to touch pre-existing files.
			try {
				closeSync(openSync(firedMarkerPath(task.detachedPaths.manifestPath), "wx", 0o600));
			} catch {
				// Marker already there (or dir gone): nothing to do.
			}
		}
	}

	/**
	 * Update a manifest through its held-open fd (owned tasks only) — never
	 * a bare path write: predictable tmpdir names must not be written via
	 * writeFileSync or a path-based reopen, which follow symlinks (CodeQL
	 * js/insecure-temporary-file).
	 */
	private rewriteManifest(
		paths: NonNullable<TaskInternal["detachedPaths"]>,
		manifest: DetachedManifest,
	): void {
		if (paths.manifestFd === undefined) return;
		const json = JSON.stringify(manifest, null, "\t");
		try {
			ftruncateSync(paths.manifestFd, 0);
			writeSync(paths.manifestFd, json, 0);
		} catch {
			// Best effort: a stale manifest only degrades a future adoption.
		}
	}

	/**
	 * Subscribe this process to a pool task: an exclusive marker file, never a
	 * manifest rewrite (ADR-0007). Subscription is additive and commutative —
	 * concurrent subscribers each get their own marker and "losing a race"
	 * does not exist; EEXIST simply means we already subscribe.
	 */
	private subscribe(manifestPath: string): void {
		writeMarker(subMarkerPath(manifestPath, process.pid));
	}

	private unsubscribe(manifestPath: string): void {
		try {
			rmSync(subMarkerPath(manifestPath, process.pid), { force: true });
		} catch {
			// Best effort only.
		}
	}

	/** Register a task from the global pool; running adoptions subscribe (ADR-0007). */
	private registerAdopted(
		manifest: DetachedManifest,
		manifestPath: string,
		deadOnArrival: boolean,
		notify: boolean,
	): TaskSnapshot {
		// An adoption-side .fired marker counts exactly like manifest.fired.
		if (manifest.pattern !== undefined && existsSync(firedMarkerPath(manifestPath))) {
			manifest.pattern.fired = true;
		}
		const id = this.nextId++;
		const task: TaskInternal = {
			snapshot: {
				id,
				label: manifest.label,
				command: manifest.command,
				shell: manifest.shell ?? "bash",
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
				unattended: deadOnArrival && notify,
				killedBy: undefined,
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
				wrapperPath: manifest.wrapperPath,
				launcherPath: manifest.launcherPath,
				manifestFd: undefined, // adopted: manifests are never rewritten in-session; fired state persists via the .fired marker
			},
			adopted: true,
			fileOffsets: { stdout: statSize(manifest.stdoutPath), stderr: statSize(manifest.stderrPath) },
			killedByUser: false,
			timedOut: false,
			finalized: false,
			unattendedBackfill: deadOnArrival && notify,
			unattendedFinishedAt: undefined,
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
			if (notify) {
				// Pool-level death backfill (ADR-0007): deliver through the normal
				// pipeline — the notifier's debounce merges a fan-out of stale
				// deaths into one turn — annotated as unattended. Nobody witnessed
				// the real death time; the exit file's mtime is the closest estimate.
				try {
					task.unattendedFinishedAt = statSync(manifest.statusPath).mtimeMs;
				} catch {
					// No status file (crash before the wrapper's printf): now is the estimate.
				}
				this.finalizeDetached(task, null);
			} else {
				// Already reported by an earlier scanner or the creator: register
				// the outcome silently so bg_status can still query it.
				const consumer = this.onExit;
				this.onExit = undefined;
				this.finalizeDetached(task, null);
				this.onExit = consumer;
			}
		} else {
			this.subscribe(manifestPath);
			this.ensureDetachedPoll();
		}
		this.evictFinished();
		return { ...task.snapshot };
	}

	/** Scan the global pool: re-subscribe same-session survivors, backfill unreported deaths, collect the finished (ADR-0007). */
	adoptDetached(): number {
		if (this.disposed) return 0;
		const known = this.knownManifestPaths();
		let adopted = 0;
		for (const entry of this.scanPool()) {
			if (known.has(entry.manifestPath)) continue; // already tracked (post-reload)
			const manifest = entry.manifest;
			if (entry.terminal) {
				const creatorAlive = manifest.ownerPid === process.pid || pidAlive(manifest.ownerPid);
				if (entry.reported && entry.liveSubscribers.length === 0 && !creatorAlive) {
					this.collectPoolEntry(entry);
					continue;
				}
				// Death notices are pool-level duty (ADR-0007): one merged backfill
				// per task, idempotent via the .reported marker — any session's scan
				// delivers it, regardless of subscription.
				this.registerAdopted(manifest, entry.manifestPath, true, !entry.reported);
			} else if (
				manifest.sessionId !== undefined &&
				manifest.sessionId !== "" &&
				manifest.sessionId === this.sessionIdValue
			) {
				// Same conversation identity (pi -c / --resume / --session): the
				// resumed session IS the task's owner — re-subscribe automatically.
				this.registerAdopted(manifest, entry.manifestPath, false, false);
				adopted += 1;
			}
			// Else: foreign — another session's task or a legacy manifest. Visible
			// via listForeign(), subscribed explicitly via adoptByPath (ADR-0007).
		}
		return adopted;
	}

	/** Pool tasks this session does not track: visible, adoptable, never auto-subscribed. */
	listForeign(): ForeignTaskInfo[] {
		const known = this.knownManifestPaths();
		const out: ForeignTaskInfo[] = [];
		for (const entry of this.scanPool()) {
			if (known.has(entry.manifestPath)) continue;
			out.push({
				manifestPath: entry.manifestPath,
				label: entry.manifest.label,
				command: entry.manifest.command,
				pid: entry.manifest.pid,
				alive: !entry.terminal,
				sessionId: entry.manifest.sessionId,
				startedAt: entry.manifest.startedAt,
			});
		}
		return out;
	}

	/** Explicitly subscribe to a foreign pool task (the bg_adopt tool, ADR-0007). */
	adoptByPath(manifestPath: string): TaskSnapshot {
		if (this.disposed) throw new Error("TaskRegistry is disposed");
		const root = realpathSync(this.detachedRoot());
		const resolved = realpathSync(dirname(manifestPath));
		if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
			throw new Error(`not a pool manifest: ${manifestPath}`);
		}
		if (this.knownManifestPaths().has(manifestPath)) {
			const existing = this.order.find((task) => task.detachedPaths?.manifestPath === manifestPath);
			if (existing) return { ...existing.snapshot };
		}
		const manifest = readManifest(manifestPath);
		if (manifest === undefined) throw new Error(`no valid manifest at ${manifestPath}`);
		if (manifest.hostname !== hostname()) throw new Error("manifest belongs to another host");
		const terminal = readExitCodeFile(manifest.statusPath) !== null || !pidAlive(manifest.pid);
		const reported = existsSync(reportedMarkerPath(manifestPath));
		return this.registerAdopted(manifest, manifestPath, terminal, terminal && !reported);
	}

	private knownManifestPaths(): Set<string> {
		return new Set(
			this.order
				.map((task) => task.detachedPaths?.manifestPath)
				.filter((path): path is string => path !== undefined),
		);
	}

	private scanPool(): PoolEntry[] {
		const root = this.detachedRoot();
		let sessionDirs: string[];
		try {
			sessionDirs = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(root, entry.name));
		} catch {
			return [];
		}
		const entries: PoolEntry[] = [];
		for (const dir of sessionDirs) {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const manifestPath = join(dir, name);
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
				const stem = name.slice(0, -".json".length);
				const liveSubscribers: number[] = [];
				const allSubscribers: number[] = [];
				for (const other of names) {
					if (!other.startsWith(`${stem}.sub.`)) continue;
					const pid = Number(other.slice(stem.length + ".sub.".length));
					if (!Number.isInteger(pid) || pid <= 0) continue;
					allSubscribers.push(pid);
					if (pid !== process.pid && pidAlive(pid)) liveSubscribers.push(pid);
				}
				// Hygiene: markers of dead subscribers can never come back.
				for (const pid of allSubscribers) {
					if (pid !== process.pid && !pidAlive(pid)) {
						try {
							rmSync(subMarkerPath(manifestPath, pid), { force: true });
						} catch {
							// Best effort only.
						}
					}
				}
				entries.push({
					manifestPath,
					manifest,
					terminal: readExitCodeFile(manifest.statusPath) !== null || !pidAlive(manifest.pid),
					reported: existsSync(reportedMarkerPath(manifestPath)),
					liveSubscribers,
				});
			}
		}
		return entries;
	}

	/** Collect a finished pool entry: terminal, reported, unsubscribed, creator gone (ADR-0007). */
	private collectPoolEntry(entry: PoolEntry): void {
		const rm = (target: string | undefined) => {
			if (target === undefined) return;
			try {
				rmSync(target, { force: true });
			} catch {
				// Best effort only.
			}
		};
		rm(entry.manifest.stdoutPath);
		rm(entry.manifest.stderrPath);
		rm(entry.manifest.statusPath);
		rm(entry.manifest.wrapperPath);
		rm(entry.manifest.launcherPath);
		rm(entry.manifestPath);
		rm(firedMarkerPath(entry.manifestPath));
		rm(reportedMarkerPath(entry.manifestPath));
		rm(killedByMarkerPath(entry.manifestPath));
		try {
			const dir = dirname(entry.manifestPath);
			const stem = basename(entry.manifestPath).replace(/\.json$/, "");
			for (const name of readdirSync(dir)) {
				if (name.startsWith(`${stem}.sub.`)) rm(join(dir, name));
			}
		} catch {
			// Best effort only.
		}
	}

	/** Detached artifacts outlive this session: close the held fd and drop our subscription only (ADR-0007). */
	private unsubscribeDetached(task: TaskInternal): void {
		if (task.detachedPaths === undefined) return;
		if (task.detachedPaths.manifestFd !== undefined) {
			try {
				closeSync(task.detachedPaths.manifestFd);
			} catch {
				// Best effort only.
			}
			task.detachedPaths.manifestFd = undefined;
		}
		this.unsubscribe(task.detachedPaths.manifestPath);
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
		snapshot.finishedAt = task.unattendedFinishedAt ?? this.now();
		snapshot.durationMs = snapshot.finishedAt - snapshot.startedAt;
		snapshot.unattended = task.unattendedBackfill;
		if (task.detachedPaths !== undefined) {
			// A foreign kill's attribution marker must ride the delivered snapshot
			// (ADR-0007) — read it BEFORE the onExit copy is made. Our own marker
			// stays silent: the "killed" status already says it was us.
			const by = readMarker(killedByMarkerPath(task.detachedPaths.manifestPath));
			if (by !== undefined && by !== "" && by !== this.selfLabel()) snapshot.killedBy = by;
		}
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
		if (task.detachedPaths !== undefined && !this.disposed) {
			// Pool-level terminal bookkeeping (ADR-0007): the death counts as
			// reported (single-shot for later scanners). A disposed registry has
			// no delivery path anymore — it must NOT claim reporting rights, or
			// the death would be marked reported without ever reaching anyone.
			writeMarker(reportedMarkerPath(task.detachedPaths.manifestPath));
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
		if (task.detachedPaths !== undefined) {
				// Cross-session attribution (ADR-0007): every other subscriber's
				// completion notice will say who killed the task they watch. Our own
				// notice stays clean — the "killed" status already says it was us.
				writeMarker(killedByMarkerPath(task.detachedPaths.manifestPath), this.selfLabel());
		}
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
			if (oldest.detachedPaths !== undefined) {
				// Terminal pool artifacts wait for scanner collection (ADR-0007).
				this.unsubscribeDetached(oldest);
			} else {
				oldest.stdout.dispose();
				oldest.stderr.dispose();
			}
		}
	}

	/** Drop all tracked state and delete spill files. Detached tasks (running or terminal) keep their pool artifacts — collection is the scanner's duty (ADR-0007). */
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
			if (detached) {
				// Terminal pool artifacts outlive this session on purpose:
				// unsubscribe only — the next scanner collects them once nobody
				// reports or watches them anymore (ADR-0007).
				this.unsubscribeDetached(task);
				continue;
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
export function getSharedRegistry(options?: RegistryOptions): TaskRegistry {
	if (globalStore[registrySymbol] === undefined) {
		globalStore[registrySymbol] = new TaskRegistry(options);
	}
	return globalStore[registrySymbol];
}
