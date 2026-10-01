/**
 * Persistent fleet-style status widget — the subagent-fleet "Async agents" look.
 *
 * Renders via ctx.ui.setWidget (string lines, belowEditor) whenever at least
 * one background task is running, and removes itself when none are. While
 * tasks run, a 500 ms ticker repaints the widget: elapsed times tick, the
 * per-task spinner rotates, and a "⎿ ↓ +N" activity subline appears under
 * tasks whose stdout+stderr grew since the previous repaint. setWidget is a
 * data-only API — pi's own render loop owns the actual painting — so the
 * ticker never races the host repaint (same pattern as pi-subagents'
 * fleet-status). The timer is stopped when the running set empties or the UI
 * unbinds (reload/headless), and unref'd so it never holds the process open.
 *
 * Pure formatting lives in formatStatusBarLines so tests cover it without a
 * UI; BgStatusBar accepts an injectable timer for the same reason.
 */

import type { TaskSnapshot } from "./tasks.ts";

export const BG_STATUS_WIDGET_KEY = "bg-shell-status";

/** Task rows shown before collapsing into "… +N more"; caps the widget height. */
const MAX_TASKS_SHOWN = 6;

/** Repaint cadence: elapsed ticking + spinner rotation (pi-subagents uses 500 ms). */
export const STATUS_REFRESH_MS = 500;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

function formatBytesDelta(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export interface FormatStatusBarOptions {
	/** Spinner phase; advances one step per repaint, offset per row. */
	tick?: number;
	/** Task id → stdout+stderr bytes grown since the previous repaint. */
	activity?: ReadonlyMap<number, number>;
}

/**
 * Fleet-tree widget lines, or undefined when nothing is running:
 *
 * ```
 * ▶ bg · background
 *  ├─ ⠋ #1 npm test · 1m 12s
 *  │    ⎿ ↓ +2.1k
 *  └─ ⠸ #2 vite dev · 31s
 *  2 running · /bg panel
 * ```
 */
export function formatStatusBarLines(
	snapshots: TaskSnapshot[],
	now: number,
	options: FormatStatusBarOptions = {},
): string[] | undefined {
	const running = snapshots.filter((task) => task.status === "running");
	if (running.length === 0) return undefined;
	const tick = options.tick ?? 0;
	const activity = options.activity;
	const shown = running.slice(0, MAX_TASKS_SHOWN);
	const overflow = running.length - shown.length;

	const lines = ["▶ bg · background"];
	shown.forEach((task, index) => {
		const isLast = index === shown.length - 1 && overflow === 0;
		const branch = isLast ? "└─" : "├─";
		const spinner = SPINNER_FRAMES[(tick + index) % SPINNER_FRAMES.length];
		const seconds = Math.max(0, Math.floor((now - task.startedAt) / 1000));
		lines.push(` ${branch} ${spinner} #${task.id} ${task.label} · ${formatElapsed(seconds)}`);
		const grew = activity?.get(task.id);
		if (grew !== undefined && grew > 0) {
			const continuation = isLast ? " " : "│";
			lines.push(` ${continuation}    ⎿ ↓ +${formatBytesDelta(grew)}`);
		}
	});
	if (overflow > 0) lines.push(` └─ … +${overflow} more`);
	lines.push(` ${running.length} running · /bg panel`);
	return lines;
}

/** Minimal UI surface the status bar needs; ExtensionContext.ui satisfies it. */
export interface StatusBarUi {
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

/** Injectable timer seam — tests drive ticks by hand, production uses globals. */
export interface WidgetTimer {
	set(handler: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

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
	private handle: unknown;
	private tick = 0;
	/** Task id → stdout+stderr bytes at last paint; deltas become activity sublines. */
	private lastBytes = new Map<number, number>();

	constructor(options: { timer?: WidgetTimer; refreshMs?: number } = {}) {
		this.timer = options.timer ?? defaultTimer;
		this.refreshMs = options.refreshMs ?? STATUS_REFRESH_MS;
	}

	/** Bind (or re-bind after /reload) the UI surface. Pass undefined in headless modes. */
	bindUi(ui: StatusBarUi | undefined): void {
		this.ui = ui;
		if (ui && this.running.length > 0) this.ensureTimer();
		else this.stopTimer();
		this.paint();
	}

	refresh(snapshots: TaskSnapshot[]): void {
		this.running = snapshots.filter((task) => task.status === "running");
		const live = new Set(this.running.map((task) => task.id));
		for (const id of this.lastBytes.keys()) {
			if (!live.has(id)) this.lastBytes.delete(id);
		}
		if (this.running.length > 0 && this.ui) this.ensureTimer();
		else this.stopTimer();
		this.paint();
	}

	clear(): void {
		this.running = [];
		this.lastBytes.clear();
		this.stopTimer();
		this.paint();
	}

	private ensureTimer(): void {
		if (this.handle !== undefined) return;
		this.handle = this.timer.set(() => this.paint(), this.refreshMs);
	}

	private stopTimer(): void {
		if (this.handle === undefined) return;
		this.timer.clear(this.handle);
		this.handle = undefined;
	}

	private paint(): void {
		if (!this.ui) return;
		const now = Date.now();
		const activity = new Map<number, number>();
		for (const task of this.running) {
			const total = task.stdoutBytes + task.stderrBytes;
			const previous = this.lastBytes.get(task.id);
			if (previous !== undefined && total > previous) activity.set(task.id, total - previous);
			this.lastBytes.set(task.id, total);
		}
		const lines = formatStatusBarLines(this.running, now, { tick: this.tick, activity });
		this.tick = (this.tick + 1) % SPINNER_FRAMES.length;
		this.ui.setWidget(BG_STATUS_WIDGET_KEY, lines, lines === undefined ? undefined : { placement: "belowEditor" });
	}
}
