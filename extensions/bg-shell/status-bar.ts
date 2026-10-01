/**
 * Persistent status-bar widget — the subagent-fleet-style "N running" line.
 *
 * Renders via ctx.ui.setWidget (string lines, aboveEditor) whenever at least
 * one background task is running, and removes itself when none are. Pure
 * formatting lives in formatStatusBarLines so tests cover it without a UI.
 */

import type { TaskSnapshot } from "./tasks.ts";

export const BG_STATUS_WIDGET_KEY = "bg-shell-status";

/** Tasks shown before collapsing into "+N more"; caps the editor-area footprint. */
const MAX_TASKS_SHOWN = 3;

export function formatShort(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatStatusBarLines(snapshots: TaskSnapshot[], now: number): string[] | undefined {
	const running = snapshots.filter((task) => task.status === "running");
	if (running.length === 0) return undefined;
	const parts = running.slice(0, MAX_TASKS_SHOWN).map((task) => {
		const seconds = Math.max(0, Math.floor((now - task.startedAt) / 1000));
		return `#${task.id} ${task.label} (${formatShort(seconds)})`;
	});
	const more = running.length > MAX_TASKS_SHOWN ? ` +${running.length - MAX_TASKS_SHOWN} more` : "";
	return [`▶ bg ${running.length} running: ${parts.join(" · ")}${more} — /bg panel`];
}

/** Minimal UI surface the status bar needs; ExtensionContext.ui satisfies it. */
export interface StatusBarUi {
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export class BgStatusBar {
	private ui: StatusBarUi | undefined;
	private running: TaskSnapshot[] = [];

	/** Bind (or re-bind after /reload) the UI surface. Pass undefined in headless modes. */
	bindUi(ui: StatusBarUi | undefined): void {
		this.ui = ui;
		this.paint();
	}

	refresh(snapshots: TaskSnapshot[]): void {
		this.running = snapshots.filter((task) => task.status === "running");
		this.paint();
	}

	clear(): void {
		this.running = [];
		this.paint();
	}

	private paint(): void {
		if (!this.ui) return;
		const lines = formatStatusBarLines(this.running, Date.now());
		this.ui.setWidget(BG_STATUS_WIDGET_KEY, lines, lines === undefined ? undefined : { placement: "aboveEditor" });
	}
}
