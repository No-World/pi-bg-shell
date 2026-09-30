/**
 * bg-shell — Claude Code-style background shell tasks for the Pi coding agent.
 *
 * bash_bg starts a child process and returns immediately; when it exits, the
 * completion notifier wakes the agent with the output tail via
 * pi.sendMessage({ triggerTurn: true }) (ADR-0003). The task registry lives
 * on globalThis, so background work survives /reload and session switches;
 * only a real quit kills running children.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompletionNotifier } from "./notify.ts";
import { getSharedRegistry } from "./tasks.ts";
import { bashBgTool, bgKillTool, bgStatusTool } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	const registry = getSharedRegistry();
	const notifier = new CompletionNotifier({
		sendMessage: (message, options) => pi.sendMessage(message, options),
	});

	// Rebind on every load: after /reload this is a fresh runtime, while the
	// registry (and its children) keep running from the previous one —
	// without this rebinding, post-reload completions would be lost (PITFALLS P1).
	registry.onExit = (snapshot, output) => notifier.push(snapshot, output);

	pi.registerTool(bashBgTool({ registry }));
	pi.registerTool(bgStatusTool({ registry }));
	pi.registerTool(bgKillTool({ registry }));

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") {
			notifier.flushNow();
			registry.dispose();
			return;
		}
		// reload / new / resume / fork: the registry intentionally survives;
		// the next load rebinds onExit to the fresh runtime.
	});
}
