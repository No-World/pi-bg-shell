/**
 * /bg — the user-facing command family for background tasks.
 *
 * Every information view opens the overlay panel (never the transcript):
 *
 *   /bg                    overlay panel (fleet view): list + detail, K kills
 *   /bg <id>               open the panel focused on one task's detail
 *   /bg tail <id> [bytes]  same, with a larger output tail in the detail view
 *   /bg log <id>           same; the detail view shows the spill-file path
 *   /bg kill <id> [sig]    terminate a task (default SIGTERM), toast ack
 *
 * Headless modes (no overlay surface) degrade to ctx.ui.notify summaries.
 * Argument parsing is a pure function so tests cover every shape.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "./tasks.ts";

export type BgCommand =
	| { kind: "panel" }
	| { kind: "detail"; id: number }
	| { kind: "tail"; id: number; bytes?: number }
	| { kind: "kill"; id: number; signal?: string }
	| { kind: "log"; id: number }
	| { kind: "usage"; error?: string };

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

export function parseBgArgs(raw: string): BgCommand {
	const args = raw.trim().split(/\s+/).filter(Boolean);
	if (args.length === 0) return { kind: "panel" };
	const [first, second, third] = args;
	if (/^#?\d+$/.test(first)) {
		return { kind: "detail", id: Number(first.replace(/^#/, "")) };
	}
	if (first === "tail") {
		const id = parseId(second);
		if (id === undefined) return { kind: "usage", error: "tail needs a task id: /bg tail <id> [bytes]" };
		const bytes = third !== undefined ? Number(third) : undefined;
		if (bytes !== undefined && (!Number.isFinite(bytes) || bytes <= 0)) {
			return { kind: "usage", error: "tail bytes must be a positive number" };
		}
		return { kind: "tail", id, bytes };
	}
	if (first === "kill") {
		const id = parseId(second);
		if (id === undefined) return { kind: "usage", error: "kill needs a task id: /bg kill <id> [signal]" };
		if (third !== undefined && !SIGNALS.has(third)) {
			return { kind: "usage", error: `unknown signal "${third}" (use SIGTERM|SIGKILL|SIGINT|SIGHUP)` };
		}
		return { kind: "kill", id, signal: third };
	}
	if (first === "log") {
		const id = parseId(second);
		if (id === undefined) return { kind: "usage", error: "log needs a task id: /bg log <id>" };
		return { kind: "log", id };
	}
	return { kind: "usage", error: `unknown subcommand "${first}"` };
}

function parseId(token: string | undefined): number | undefined {
	if (token === undefined || !/^#?\d+$/.test(token)) return undefined;
	return Number(token.replace(/^#/, ""));
}

/** The ui surfaces the command handler needs; ExtensionCommandContext.ui satisfies both. */
export interface PanelHostUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
		options?: PanelCustomOptions,
	): Promise<T>;
}

export interface BgCommandDeps {
	registry: TaskRegistry;
	/** Opens the overlay panel; injected so tests can capture the call. */
	openPanel: (
		ctx: { mode: string; hasUI: boolean; ui: PanelHostUi },
		initial?: { id?: number; tailBytes?: number },
	) => void;
}

/** Structural subset of ui.custom options the panel host needs. */
export interface PanelCustomOptions {
	overlay?: boolean;
	overlayOptions?: {
		width?: number | `${number}%`;
		minWidth?: number;
		maxHeight?: number | `${number}%`;
	};
}

const USAGE = "/bg usage: /bg · /bg <id> · /bg tail <id> [bytes] · /bg kill <id> [signal] · /bg log <id>";

export function registerBgCommand(pi: ExtensionAPI, deps: BgCommandDeps): void {
	pi.registerCommand("bg", {
		description: "Background shell tasks: panel, tail, kill, log",
		getArgumentCompletions: (prefix: string) => {
			const completions: { value: string; label: string; description?: string }[] = [];
			const trimmed = prefix.trim();
			if (trimmed === "") {
				completions.push(
					{ value: "kill ", label: "kill", description: "terminate a task" },
					{ value: "tail ", label: "tail", description: "panel with a larger output tail" },
					{ value: "log ", label: "log", description: "panel with the spill-file path" },
				);
			}
			const token = trimmed.split(/\s+/).at(-1) ?? "";
			if (/^#?\d+$/.test(token)) {
				for (const task of deps.registry.status()) {
					completions.push({
						value: `bg ${task.id} `,
						label: `#${task.id}`,
						description: `${task.status} · ${task.label}`,
					});
				}
			}
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx) => {
			const command = parseBgArgs(args);
			const ui = ctx.ui as PanelHostUi;
			switch (command.kind) {
				case "panel":
					deps.openPanel(ctx);
					return;
				case "detail":
					if (!requireTask(deps.registry, ui, command.id)) return;
					deps.openPanel(ctx, { id: command.id });
					return;
				case "tail":
					if (!requireTask(deps.registry, ui, command.id)) return;
					deps.openPanel(ctx, { id: command.id, tailBytes: command.bytes });
					return;
				case "log":
					if (!requireTask(deps.registry, ui, command.id)) return;
					deps.openPanel(ctx, { id: command.id });
					return;
				case "kill": {
					const snapshot = deps.registry.status(command.id)[0];
					if (!snapshot) {
						ui.notify(`No background task with id ${command.id}`, "warning");
						return;
					}
					if (snapshot.status !== "running") {
						ui.notify(`Task #${command.id} already ${snapshot.status}`, "info");
						return;
					}
					deps.registry.kill(command.id, (command.signal ?? "SIGTERM") as NodeJS.Signals);
					ui.notify(`Sent ${command.signal ?? "SIGTERM"} to task #${command.id}`, "info");
					return;
				}
				case "usage":
					ui.notify(command.error ? `${command.error}\n${USAGE}` : USAGE, "warning");
					return;
			}
		},
	});
}

function requireTask(registry: TaskRegistry, ui: PanelHostUi, id: number): boolean {
	if (registry.status(id).length === 0) {
		ui.notify(`No background task with id ${id}`, "warning");
		return false;
	}
	return true;
}
