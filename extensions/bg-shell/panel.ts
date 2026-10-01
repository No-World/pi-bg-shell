/**
 * Fleet-style overlay panel for background tasks (the /bg popup).
 *
 * Visual contract: a full box border (╭─╮ │ ╰─╯) with the title embedded in
 * the top edge, and every body row background-filled to the full inner width
 * — that combination is what makes it read as a modal popup instead of text
 * floating in the transcript.
 *
 * Input is matched against raw terminal escape sequences and single
 * characters — no pi-tui runtime import — so the component is fully
 * unit-testable under `node --test`. The real Theme injected by the
 * ui.custom() factory satisfies PanelTheme structurally.
 */

import type { TaskOutput, TaskRegistry, TaskSnapshot } from "./tasks.ts";
import { formatShort } from "./status-bar.ts";

export interface PanelTheme {
	fg(role: never, text: string): string;
	bg(role: never, text: string): string;
	bold(text: string): string;
}

const STATUS_ROLE: Record<TaskSnapshot["status"], string> = {
	running: "warning",
	completed: "success",
	failed: "error",
	killed: "error",
	timeout: "error",
};

export interface PanelDeps {
	registry: TaskRegistry;
	theme: PanelTheme;
	/** Optional notify hook for kill feedback (wired to ctx.ui.notify). */
	onNotify?: (message: string, type: "info" | "warning" | "error") => void;
	/** Open the panel focused on this task's detail view. */
	initialId?: number;
	/** Detail-view tail budget in bytes (default 4096; /bg tail overrides). */
	initialTailBytes?: number;
	now?: () => number;
}

export type PanelAction = "none" | "close" | "killed";

interface InputKey {
	name: "up" | "down" | "enter" | "escape" | "q" | "K" | "r" | "other";
	char: string;
}

/** Raw terminal data → logical key. Exported for tests. */
export function parsePanelInput(data: string): InputKey {
	if (data === "\x1b[A" || data === "k") return { name: "up", char: data };
	if (data === "\x1b[B" || data === "j") return { name: "down", char: data };
	if (data === "\r" || data === "\n") return { name: "enter", char: data };
	if (data === "\x1b") return { name: "escape", char: data };
	if (data === "q") return { name: "q", char: data };
	if (data === "K") return { name: "K", char: data };
	if (data === "r") return { name: "r", char: data };
	return { name: "other", char: data };
}

export class BgPanelComponent {
	private view: "list" | "detail" = "list";
	private tasks: TaskSnapshot[] = [];
	private selected = 0;
	private detailId: number | undefined;
	private readonly detailBytes: number;
	private readonly deps: PanelDeps;
	private readonly done: () => void;

	constructor(deps: PanelDeps, done: () => void) {
		this.deps = deps;
		this.done = done;
		this.detailBytes = deps.initialTailBytes ?? 4096;
		this.refresh();
		if (deps.initialId !== undefined && this.tasks.some((task) => task.id === deps.initialId)) {
			this.view = "detail";
			this.detailId = deps.initialId;
		}
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	refresh(): void {
		this.tasks = this.deps.registry.status();
		if (this.selected >= this.tasks.length) this.selected = Math.max(0, this.tasks.length - 1);
	}

	handleInput(data: string): PanelAction {
		const key = parsePanelInput(data);
		if (key.name === "r") {
			this.refresh();
			return "none";
		}
		if (this.view === "list") return this.handleListInput(key);
		return this.handleDetailInput(key);
	}

	private handleListInput(key: InputKey): PanelAction {
		switch (key.name) {
			case "up":
				this.selected = this.selected > 0 ? this.selected - 1 : this.tasks.length - 1;
				return "none";
			case "down":
				this.selected = this.selected < this.tasks.length - 1 ? this.selected + 1 : 0;
				return "none";
			case "enter": {
				const task = this.tasks[this.selected];
				if (task) {
					this.view = "detail";
					this.detailId = task.id;
				}
				return "none";
			}
			case "K":
				return this.killSelected();
			case "escape":
			case "q":
				this.done();
				return "close";
			default:
				return "none";
		}
	}

	private handleDetailInput(key: InputKey): PanelAction {
		switch (key.name) {
			case "K":
				return this.killDetail();
			case "escape":
				this.view = "list";
				return "none";
			case "q":
				this.done();
				return "close";
			default:
				return "none";
		}
	}

	private killSelected(): PanelAction {
		const task = this.tasks[this.selected];
		if (!task || task.status !== "running") return "none";
		this.deps.registry.kill(task.id, "SIGTERM");
		this.deps.onNotify?.(`Sent SIGTERM to bg task #${task.id}`, "info");
		this.refresh();
		return "killed";
	}

	private killDetail(): PanelAction {
		if (this.detailId === undefined) return "none";
		const task = this.tasks.find((entry) => entry.id === this.detailId);
		if (!task || task.status !== "running") return "none";
		this.deps.registry.kill(task.id, "SIGTERM");
		this.deps.onNotify?.(`Sent SIGTERM to bg task #${task.id}`, "info");
		this.refresh();
		return "killed";
	}

	render(width: number): string[] {
		if (width < 24) {
			return [fitLine("bg panel: q closes (needs 24+ cols)", width)];
		}
		const body = this.view === "list" ? this.renderList() : this.renderDetail();
		return this.frame(body, width);
	}

	/** Full box border + background-filled rows — what makes it read as a popup. */
	private frame(body: string[], width: number): string[] {
		const theme = this.deps.theme;
		const inner = width - 2;
		const title = this.view === "list" ? " bg tasks " : ` bg task #${this.detailId ?? "?"} `;
		const left = Math.max(1, Math.floor((inner - displayWidth(title)) / 2));
		const right = Math.max(1, inner - displayWidth(title) - left);
		const lines: string[] = [
			theme.fg("border" as never, `╭${"─".repeat(left)}`) +
				theme.bold(theme.fg("accent" as never, title)) +
				theme.fg("border" as never, `${"─".repeat(right)}╮`),
		];
		for (const line of body) {
			lines.push(
				theme.fg("border" as never, "│") +
					theme.bg("customMessageBg" as never, fitLine(line, inner)) +
					theme.fg("border" as never, "│"),
			);
		}
		lines.push(theme.fg("border" as never, `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	private renderList(): string[] {
		const theme = this.deps.theme;
		if (this.tasks.length === 0) {
			return [
				theme.fg("dim" as never, " No background tasks yet — the agent starts them with bash_bg."),
				"",
				helpLine("list"),
			];
		}
		const now = this.now();
		const rows = this.tasks.map((task, index) => {
			const marker = index === this.selected ? "▸ " : "  ";
			const time =
				task.status === "running"
					? `running ${formatShort(Math.max(0, Math.floor((now - task.startedAt) / 1000)))}`
					: `${task.status}${task.exitCode !== null ? ` exit ${task.exitCode}` : ""} in ${formatShort(
							Math.floor((task.durationMs ?? 0) / 1000),
						)}`;
			const body =
				theme.fg(STATUS_ROLE[task.status] as never, `#${task.id} ${time}`) +
				theme.fg("muted" as never, ` · ${task.label}`);
			return `${theme.fg("accent" as never, marker)}${body}`;
		});
		return [...rows, "", helpLine("list")];
	}

	private renderDetail(): string[] {
		const theme = this.deps.theme;
		const task = this.tasks.find((entry) => entry.id === this.detailId);
		if (!task) return [theme.fg("dim" as never, " Task evicted or unknown."), "", helpLine("detail")];
		const output: TaskOutput | undefined = this.deps.registry.output(task.id, this.detailBytes);
		const lines: string[] = [];
		lines.push(
			theme.fg(STATUS_ROLE[task.status] as never, ` ${task.status}`) +
				(task.exitCode !== null ? theme.fg("muted" as never, ` exit ${task.exitCode}`) : "") +
				(task.durationMs !== undefined
					? theme.fg("muted" as never, ` in ${formatShort(Math.floor(task.durationMs / 1000))}`)
					: ""),
		);
		lines.push(theme.fg("muted" as never, ` cmd: ${task.command}`));
		if (task.errorMessage !== undefined) {
			lines.push(theme.fg("error" as never, ` error: ${task.errorMessage}`));
		}
		lines.push("");
		if (output) {
			lines.push(...this.tailBlock("stdout", output.stdoutTail, output.stdoutBytes, output.stdoutSpillPath));
			lines.push("");
			lines.push(...this.tailBlock("stderr", output.stderrTail, output.stderrBytes, output.stderrSpillPath));
		}
		lines.push("", helpLine("detail"));
		return lines;
	}

	private tailBlock(name: string, tail: string, totalBytes: number, spillPath: string | undefined): string[] {
		const theme = this.deps.theme;
		const header = theme.fg("dim" as never, ` --- ${name} tail (${tail.length}/${totalBytes} bytes) ---`);
		if (tail === "") return [header, theme.fg("dim" as never, " (empty)")];
		const body = tail
			.replace(/\n$/, "")
			.split("\n")
			.map((line) => ` ${line}`);
		const lines = [header, ...body];
		if (spillPath !== undefined) {
			lines.push(theme.fg("dim" as never, ` (full output: ${spillPath})`));
		}
		return lines;
	}
}

function helpLine(view: "list" | "detail"): string {
	return view === "list"
		? " ↑↓ select · enter detail · K kill · r refresh · q close"
		: " esc back · K kill · r refresh · q close";
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** East-Asian wide code-point ranges — CJK labels must count as 2 columns. */
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

/** Terminal columns occupied by a string, skipping ANSI color escapes. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text.replace(ANSI_RE, "")) {
		width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return width;
}

/** Pad or width-truncate a row to exactly `width` display columns. */
export function fitLine(text: string, width: number): string {
	const current = displayWidth(text);
	if (current >= width) return truncateByWidth(text, width);
	return text + " ".repeat(width - current);
}

function truncateByWidth(line: string, width: number): string {
	if (width <= 0) return "";
	let kept = 0;
	const out: string[] = [];
	const plain = line.replace(ANSI_RE, "");
	for (const char of plain) {
		const charWidth = isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
		if (kept + charWidth > Math.max(0, width - 1)) break;
		out.push(char);
		kept += charWidth;
	}
	return displayWidth(plain) <= width - 1 ? plain : `${out.join("")}…`;
}
