/**
 * Persistent fleet-style status widget — the pi-subagents "async subagent"
 * card look, adapted to background shell tasks.
 *
 * Registered via ctx.ui.setWidget's factory form so pi hands us the tui
 * (for requestRender) and the theme (for coloring); placement is above the
 * input editor. While tasks run, a 500 ms ticker recomputes per-task
 * activity (output bytes delta + last output line) and asks pi to repaint —
 * painting itself stays owned by pi's render loop, so the timer never races
 * the host (oracle-reviewed). Elapsed times tick, spinners rotate, and rows
 * show the original command plus the task's current output. The widget is
 * removed (setWidget(key, undefined)) and the timer stopped when the last
 * task ends, when the UI unbinds, or on any session_shutdown reason.
 *
 * Pure formatting lives in formatStatusBarLines (theme + width injected) so
 * tests cover it without a UI; BgStatusBar accepts an injectable timer and
 * output provider for the same reason.
 */

import type { TaskSnapshot } from "./tasks.ts";

export const BG_STATUS_WIDGET_KEY = "bg-shell-status";

/** Task cards shown before collapsing into "… +N more"; caps the widget height. */
const MAX_TASKS_SHOWN = 6;

/** Repaint cadence — deliberately identical to pi-subagents' fleet-status
 * REFRESH_MS (500 ms) so widgets animate at the same beat when both run. */
export const STATUS_REFRESH_MS = 500;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** East-Asian wide code-point ranges — CJK must count as 2 columns. */
function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** Terminal columns occupied, skipping ANSI escapes (unstyled strings). */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text.replace(ANSI_RE, "")) {
		width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return width;
}

/**
 * Truncate an ANSI-styled line to `width` display columns, keeping the
 * colors of everything up to the cut and resetting after the ellipsis so a
 * truncated color span cannot bleed into the next line.
 */
export function truncateStyled(text: string, width: number): string {
	if (width <= 0) return "";
	let kept = 0;
	let out = "";
	let styled = false;
	for (let i = 0; i < text.length; ) {
		const match = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
		if (match) {
			out += match[0];
			styled = true;
			i += match[0].length;
			continue;
		}
		const codePoint = text.codePointAt(i) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const charWidth = isWideCodePoint(codePoint) ? 2 : 1;
		if (kept + charWidth > width - 1) {
			return styled ? `${out}…\x1b[0m` : `${out}…`;
		}
		kept += charWidth;
		out += char;
		i += char.length;
	}
	return out;
}

export function formatShort(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/** "12m 32s"-style elapsed for the live widget (subagent-fleet look). */
export function formatElapsed(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${(minutes % 60)}m ${seconds}s`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export interface StatusTheme {
	fg(role: never, text: string): string;
}

/** Live per-task facts recomputed on every tick. */
export interface TaskActivity {
	/** stdout+stderr bytes so far — read fresh from the registry each tick. */
	totalBytes: number;
	/** Last non-empty output line (stdout preferred, stderr fallback). */
	lastLine: string;
}

export interface WidgetState {
	running: TaskSnapshot[];
	now: number;
	/** Spinner phase; advances one step per tick, offset per row. */
	tick: number;
	activity: ReadonlyMap<number, TaskActivity>;
}

/**
 * Card-style widget lines, or undefined when nothing is running:
 *
 * ```
 * bg · background
 *    ⠸ chatty-ticker · running · 1m 12s
 *      cmd: for i in $(seq 150); do echo …
 *      ⎿  ↓ 18.4k (+2.1k) · [16:52:31] chatty heartbeat #93 …
 *    ⠋ quiet-soak · running · 4m 2s
 *      cmd: sleep 300
 *  2 running · /bg panel
 * ```
 */
export function formatStatusBarLines(
	state: WidgetState,
	theme: StatusTheme,
	width: number,
): string[] | undefined {
	const { now, tick, activity } = state;
	const running = state.running.filter((task) => task.status === "running");
	if (running.length === 0) return undefined;
	const shown = running.slice(0, MAX_TASKS_SHOWN);
	const overflow = running.length - shown.length;

	const lines = ["bg · background"];
	shown.forEach((task, index) => {
		const spinner = SPINNER_FRAMES[(tick + index) % SPINNER_FRAMES.length];
		const seconds = Math.max(0, Math.floor((now - task.startedAt) / 1000));
		const row =
			`   ${spinner} #${task.id} ${task.label}` +
			`${theme.fg("dim" as never, " · running · ")}` +
			`${theme.fg("muted" as never, formatElapsed(seconds))}`;
		lines.push(truncateStyled(row, width));

		const cmd = truncateStyled(
			`     ${theme.fg("dim" as never, "cmd: ")}${theme.fg("toolOutput" as never, task.command)}`,
			width,
		);
		lines.push(cmd);

		const live = activity.get(task.id);
		if (live && (live.lastLine !== "" || live.totalBytes > 0)) {
			const detail =
				live.lastLine !== ""
					? `${theme.fg("dim" as never, " · ")}${theme.fg("toolOutput" as never, live.lastLine)}`
					: "";
			lines.push(
				truncateStyled(
					`     ${theme.fg("dim" as never, "⎿  ")}${theme.fg("muted" as never, `↓ ${formatBytes(live.totalBytes)}`)}${detail}`,
					width,
				),
			);
		}
	});
	if (overflow > 0) lines.push(truncateStyled(`   ${theme.fg("dim" as never, `… +${overflow} more`)}`, width));
	lines.push(truncateStyled(` ${theme.fg("dim" as never, `${running.length} running · /bg panel`)}`, width));
	return lines;
}

/** Minimal tui surface the widget needs from pi's factory. */
export interface WidgetTui {
	requestRender(): void;
}

export interface WidgetComponent {
	render(width: number): string[];
	dispose?(): void;
}

export interface StatusBarUi {
	setWidget(
		key: string,
		content:
			| string[]
			| ((tui: WidgetTui, theme: StatusTheme) => WidgetComponent)
			| undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

/** Injectable timer seam — tests drive ticks by hand, production uses globals. */
export interface WidgetTimer {
	set(handler: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** Output snapshot provider; index.ts wires it to registry.output(id, bytes). */
export type OutputProvider = (
	id: number,
) => { stdoutTail: string; stderrTail: string; stdoutBytes: number; stderrBytes: number } | undefined;

const defaultTimer: WidgetTimer = {
	set: (handler, ms) => {
		const handle = setInterval(handler, ms);
		handle.unref?.();
		return handle;
	},
	clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class BgStatusBar {
	private ui: StatusBarUi | undefined;
	private running: TaskSnapshot[] = [];
	private readonly timer: WidgetTimer;
	private readonly refreshMs: number;
	private readonly getOutput: OutputProvider;
	private handle: unknown;
	private tick = 0;
	/** State frozen at the last tick — render() draws only from this frame so
	 * spinner, elapsed, and output advance in lockstep, never on foreign repaints. */
	private frame: WidgetState | undefined;
	private registered = false;
	private tui: WidgetTui | undefined;
	private theme: StatusTheme | undefined;
	private activity = new Map<number, TaskActivity>();

	constructor(options: { timer?: WidgetTimer; refreshMs?: number; getOutput?: OutputProvider } = {}) {
		this.timer = options.timer ?? defaultTimer;
		this.refreshMs = options.refreshMs ?? STATUS_REFRESH_MS;
		this.getOutput = options.getOutput ?? (() => undefined);
	}

	/** Bind (or re-bind after /reload) the UI surface. Pass undefined in headless modes. */
	bindUi(ui: StatusBarUi | undefined): void {
		this.ui = ui;
		// Fresh surface: the factory-form widget must register against THIS ui,
		// so a stale registered flag from a previous bind can never survive.
		this.registered = false;
		this.tui = undefined;
		this.theme = undefined;
		if (!ui) {
			this.stopTimer();
			return;
		}
		if (this.running.length > 0) this.ensureTimer();
		this.sync();
	}

	refresh(snapshots: TaskSnapshot[]): void {
		this.running = snapshots.filter((task) => task.status === "running");
		const live = new Set(this.running.map((task) => task.id));
		for (const id of this.activity.keys()) {
			if (!live.has(id)) this.activity.delete(id);
		}
		if (this.running.length > 0 && this.ui) this.ensureTimer();
		else this.stopTimer();
		this.sync();
	}

	clear(): void {
		this.running = [];
		this.activity.clear();
		this.stopTimer();
		this.sync();
	}

	private ensureTimer(): void {
		if (this.handle !== undefined) return;
		this.handle = this.timer.set(() => this.sync(), this.refreshMs);
	}

	private stopTimer(): void {
		if (this.handle === undefined) return;
		this.timer.clear(this.handle);
		this.handle = undefined;
	}

	/** Recompute activity, then register/remove the widget and ask pi to repaint. */
	private sync(): void {
		if (!this.ui) return;
		if (this.running.length === 0) {
			if (this.registered) {
				this.ui.setWidget(BG_STATUS_WIDGET_KEY, undefined);
				this.registered = false;
			}
			return;
		}
		this.tick = (this.tick + 1) % SPINNER_FRAMES.length;
		for (const task of this.running) {
			const output = this.getOutput(task.id);
			if (output) {
				const tail = output.stdoutTail || output.stderrTail;
				const lastLine = tail.replace(/\n+$/, "").split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
				this.activity.set(task.id, {
					totalBytes: output.stdoutBytes + output.stderrBytes,
					lastLine: lastLine.slice(0, 160),
				});
			}
		}
		this.frame = { running: this.running, now: Date.now(), tick: this.tick, activity: this.activity };
		this.ensureRegistered();
		this.tui?.requestRender();
	}

	private ensureRegistered(): void {
		if (this.registered || !this.ui) return;
		this.ui.setWidget(
			BG_STATUS_WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				this.theme = theme;
				return {
					render: (width: number) =>
						formatStatusBarLines(
							this.frame ?? { running: this.running, now: 0, tick: 0, activity: this.activity },
							this.theme ?? theme,
							width,
						) ?? [],
					dispose: () => {
						if (this.tui === tui) this.tui = undefined;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		this.registered = true;
	}
}
