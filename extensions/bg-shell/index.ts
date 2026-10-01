/**
 * bg-shell — Claude Code-style background shell tasks for the Pi coding agent.
 *
 * bash_bg starts a child process and returns immediately; when it exits, the
 * completion notifier wakes the agent with the output tail via
 * pi.sendMessage({ triggerTurn: true }) (ADR-0003). The task registry lives
 * on globalThis, so background work survives /reload and session switches;
 * only a real quit kills running children.
 *
 * User surface: a persistent status-bar widget while tasks run, a fleet-style
 * /bg overlay panel for inspection, and /bg kill for termination.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBgCommand, type PanelHostUi } from "./command.ts";
import { CompletionNotifier } from "./notify.ts";
import { BgPanelComponent } from "./panel.ts";
import { defaultTimeoutMsFromEnv, getSharedRegistry } from "./tasks.ts";
import { BgStatusBar } from "./status-bar.ts";
import { bashBgTool, bgKillTool, bgStatusTool } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	// Env override is read once per process: the shared registry survives
	// reloads, so the first creation wins (ADR-0004).
	const registry = getSharedRegistry({ defaultTimeoutMs: defaultTimeoutMsFromEnv() });
	const notifier = new CompletionNotifier({
		sendMessage: (message, options) => pi.sendMessage(message, options),
	});
	const statusBar = new BgStatusBar({
		// Per-tick output facts for the activity line: bytes + last output line.
		getOutput: (id) => registry.output(id, 512),
	});

	// Rebind on every load: after /reload this is a fresh runtime, while the
	// registry (and its children) keep running from the previous one —
	// without this rebinding, post-reload completions would be lost (PITFALLS P1).
	registry.onExit = (snapshot, output) => {
		notifier.push(snapshot, output);
		statusBar.refresh(registry.status());
	};
	// Running-task events (on_pattern / report_every) ride the same rebinding
	// rule as onExit: post-reload events must reach the fresh runtime (PITFALLS P1).
	registry.onRunningEvent = (snapshot, output, event) => {
		notifier.pushEvent(snapshot, output, event);
		statusBar.refresh(registry.status());
	};

	const refreshStatus = () => statusBar.refresh(registry.status());

	pi.registerTool(bashBgTool({ registry, onChange: refreshStatus }));
	pi.registerTool(bgStatusTool({ registry }));
	pi.registerTool(bgKillTool({ registry, onChange: refreshStatus }));

	pi.on("session_start", async (_event, ctx) => {
		// Capture (or re-capture after reload) the UI surface for the widget.
		statusBar.bindUi(ctx.hasUI ? ctx.ui : undefined);
		// Re-adopt detached survivors from previous sessions (ADR-0006):
		// alive ones resume tracking + notifications; dead ones register silently.
		try {
			registry.adoptDetached();
		} catch {
			// Adoption is best-effort at load; bg_status still lists what landed.
		}
		refreshStatus();
	});

	registerBgCommand(pi, {
		registry,
		openPanel: (ctx, initial) => openPanel(ctx, initial),
	});

	function openPanel(
		ctx: { mode: string; hasUI: boolean; ui: PanelHostUi },
		initial?: { id?: number; tailBytes?: number },
	): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			// No overlay surface (RPC/JSON/print): degrade to a notify summary.
			const tasks = registry.status();
			const lines = tasks.map((task) => `#${task.id} ${task.status} · ${task.label}`);
			ctx.ui.notify(lines.length > 0 ? `bg tasks:\n${lines.join("\n")}` : "No background tasks yet", "info");
			return;
		}
		void ctx.ui.custom<void>(
			(_tui, theme, _keybindings, done) =>
				new BgPanelComponent(
					{
						registry,
						theme: theme as never,
						onNotify: (message, type) => ctx.ui.notify(message, type),
						initialId: initial?.id,
						initialTailBytes: initial?.tailBytes,
					},
					() => done(undefined),
				),
			{ overlay: true, overlayOptions: { width: "70%", minWidth: 40, maxHeight: "80%" } },
		);
	}

	pi.on("session_shutdown", async (event) => {
		// Stop this runtime's ticker + widget on every shutdown reason: on
		// reload the old 500 ms interval would keep painting into a dead ui —
		// the fresh load rebinds and restarts it in its own session_start.
		statusBar.clear();
		if (event.reason === "quit") {
			notifier.flushNow();
			registry.dispose();
			return;
		}
		// reload / new / resume / fork: the registry intentionally survives;
		// the next load rebinds onExit to the fresh runtime.
	});
}
