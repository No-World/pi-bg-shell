import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskRegistry } from "../extensions/bg-shell/tasks.ts";
import { bashBgTool, bgAdoptTool, bgKillTool, bgStatusTool, powershellBgTool } from "../extensions/bg-shell/tools.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

interface RegisteredTool {
	name: string;
	hasExecute: boolean;
	hasPrepareArguments: boolean;
	hasPromptSnippet: boolean;
	guidelineCount: number;
	defaultActive: boolean | undefined;
}

/** Minimal structural stand-in for the ExtensionAPI registration surface. */
function stubPi() {
	const tools: RegisteredTool[] = [];
	const handlers: { event: string; handler: (event: unknown) => Promise<void> | void }[] = [];
	const commands: { name: string; handler: (args: string, ctx: unknown) => Promise<void> }[] = [];
	return {
		tools,
		handlers,
		commands,
		registerTool(tool: Record<string, unknown>) {
			tools.push({
				name: String(tool.name),
				hasExecute: typeof tool.execute === "function",
				hasPrepareArguments: typeof tool.prepareArguments === "function",
				hasPromptSnippet: typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0,
				guidelineCount: Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines.length : 0,
				defaultActive: typeof tool.defaultActive === "boolean" ? tool.defaultActive : undefined,
			});
		},
		on(event: string, handler: (event: unknown) => Promise<void> | void) {
			handlers.push({ event, handler });
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push({ name, handler: options.handler });
		},
	};
}

test("extension entry registers the tool set and a quit-only shutdown handler", async () => {
	const { default: factory } = await import("../extensions/bg-shell/index.ts");
	const pi = stubPi();
	factory(pi as never);
	// win32 additionally exposes the native-parity powershell_bg sibling,
	// inactive by default exactly like pi's optional powershell tool (ADR-0009).
	const expected =
		process.platform === "win32"
			? ["bash_bg", "bg_adopt", "bg_kill", "bg_status", "powershell_bg"]
			: ["bash_bg", "bg_adopt", "bg_kill", "bg_status"];
	assert.deepEqual(
		pi.tools.map((tool) => tool.name).sort(),
		expected,
	);
	if (process.platform === "win32") {
		const pwsh = pi.tools.find((tool) => tool.name === "powershell_bg");
		assert.equal(pwsh?.defaultActive, false, "powershell_bg stays opt-in via defaultTools (ADR-0009)");
	}
	assert.ok(pi.tools.every((tool) => tool.hasExecute));
	// Tools without a promptSnippet are omitted from the system prompt's
	// Available-tools section and the model keeps reaching for bash instead —
	// this guards the visibility fix for all three tools.
	assert.ok(
		pi.tools.every((tool) => tool.hasPromptSnippet),
		"every bg-shell tool must carry a promptSnippet",
	);
	assert.ok(pi.tools.every((tool) => tool.guidelineCount >= 1));
	assert.deepEqual(
		pi.commands.map((command) => command.name),
		["bg"],
		"the /bg command registers alongside the tools",
	);
	const shutdown = pi.handlers.find((handler) => handler.event === "session_shutdown");
	assert.ok(shutdown !== undefined, "session_shutdown handler registered");
	// quit must dispose the shared registry (fresh one — keep this test hermetic
	// by checking the handler contract on the process-global registry).
	const { getSharedRegistry } = await import("../extensions/bg-shell/tasks.ts");
	const before = getSharedRegistry();
	await shutdown.handler({ type: "session_shutdown", reason: "quit" });
	const after = getSharedRegistry();
	assert.notEqual(after, before, "quit replaces the disposed shared registry");
	// Non-quit reasons keep the registry instance.
	const { getSharedRegistry: again } = await import("../extensions/bg-shell/tasks.ts");
	const kept = again();
	await pi.handlers
		.filter((handler) => handler.event === "session_shutdown")
		.at(-1)!
		.handler({ type: "session_shutdown", reason: "reload" });
	assert.equal(again(), kept);
});

test("coerceNumericId normalizes '#7' and '7' but leaves other shapes alone", () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const status = bgStatusTool({ registry }) as unknown as {
		prepareArguments?: (args: unknown) => unknown;
	};
	const prepare = status.prepareArguments;
	assert.ok(prepare !== undefined);
	assert.deepEqual(prepare({ id: "#3" }), { id: 3 });
	assert.deepEqual(prepare({ id: "12" }), { id: 12 });
	assert.deepEqual(prepare({ id: 4 }), { id: 4 });
	assert.deepEqual(prepare({}), {});
	assert.equal(prepare(null), null);
	registry.dispose();
});

test("bash_bg execute starts a task and the completion flows to bg_status", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const start = bashBgTool({ registry }) as unknown as {
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
	};
	const result = await start.execute("call-1", { command: "echo smoke", timeout_sec: 0 });
	assert.match(result.content[0].text, /Started background task #1/);
	assert.match(result.content[0].text, /do not poll/);
	assert.match(result.content[0].text, /bg_status.*id.*1.*progress/s);
	await waitFor(() => registry.status(1)[0].status !== "running");
	const status = bgStatusTool({ registry }) as unknown as {
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
	};
	const single = await status.execute("call-2", { id: 1 });
	assert.match(single.content[0].text, /#1 completed/);
	assert.match(single.content[0].text, /smoke/);
	registry.dispose();
});

test("bg_kill execute kills a running task and reports already-finished tasks", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const start = bashBgTool({ registry }) as unknown as {
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
	};
	const kill = bgKillTool({ registry }) as unknown as {
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
	};
	await start.execute("call-1", { command: "sleep 30", timeout_sec: 0 });
	const killed = await kill.execute("call-2", { id: 1 });
	assert.match(killed.content[0].text, /Sent SIGTERM to task #1/);
	await waitFor(() => registry.status(1)[0].status !== "running");
	const again = await kill.execute("call-3", { id: 1 });
	assert.match(again.content[0].text, /already killed/);
	await assert.rejects(kill.execute("call-4", { id: 99 }), /No background task with id 99/);
	registry.dispose();
});

test("bg_status lists foreign pool tasks and bg_adopt subscribes to one", async () => {
	const shared = mkdtempSync(join(tmpdir(), "pi-bg-shell-test-tooladopt-"));
	const registry = new TaskRegistry({ killGraceMs: 100, detachedDirPath: shared, sessionId: "sess-tool" });
	const holder = registry.start({ command: "sleep 30", timeoutMs: 0 });
	await waitFor(() => registry.status(holder.id)[0].status === "running");
	const dir = join(shared, "s-f");
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "f.json");
	writeFileSync(join(dir, "o.log"), "");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			version: 1,
			pid: holder.pid,
			command: "sleep 30",
			label: "foreign-tool",
			cwd: process.cwd(),
			startedAt: Date.now(),
			hostname: hostname(),
			stdoutPath: join(dir, "o.log"),
			stderrPath: join(dir, "e.log"),
			statusPath: join(dir, ".exit"),
		}),
	);
	const status = bgStatusTool({ registry }) as unknown as {
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
	};
	const list = await status.execute("c1", {});
	assert.match(list.content[0].text, /Global pool/);
	assert.match(list.content[0].text, /foreign-tool/);
	const adopt = bgAdoptTool({ registry }) as unknown as {
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
	};
	const adopted = await adopt.execute("c2", { path: manifestPath });
	assert.match(adopted.content[0].text, /Adopted pool task as #\d+/);
	assert.match(adopted.content[0].text, /subscribed/);
	await assert.rejects(adopt.execute("c3", { path: join(dir, "nope.json") }), /no valid manifest/);
	registry.kill(holder.id, "SIGKILL");
	await waitFor(() => registry.status(holder.id)[0].status !== "running");
	registry.dispose();
});

test("registry dispose removes spill files from disk", async () => {
	const registry = new TaskRegistry({ maxBufferBytes: 16, killGraceMs: 100 });
	const snapshot = registry.start({ command: `printf '%s' '${"z".repeat(64)}'`, timeoutMs: 0 });
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const spill = registry.status(snapshot.id)[0].stdoutSpillPath;
	assert.ok(spill !== undefined);
	registry.dispose();
	assert.deepEqual(registry.status(), []);
	assert.ok(!existsSync(spill));
});

test("bash_bg prepends shellCommandPrefix and passes the resolved spec (native parity)", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const start = bashBgTool({
		registry,
		getSettings: () => ({ shellCommandPrefix: "export CI=1" }),
		resolveBash: () => ({
			name: "bash",
			bin: "bash",
			flavor: process.platform === "win32" ? "wsl-bash" : "posix-bash",
			args: ["-c"],
		}),
	}) as unknown as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
	await start.execute("call-1", { command: "echo prefix-smoke", timeout_sec: 0 });
	const snapshot = registry.status(1)[0];
	assert.equal(snapshot.command, "export CI=1\necho prefix-smoke", "prefix joined with a newline, like native");
	await waitFor(() => registry.status(1)[0].status !== "running");
	assert.equal(registry.status(1)[0].status, "completed");
	registry.dispose();
});

test("powershell_bg starts a task through the pwsh spec", async () => {
	const starts: Array<Record<string, unknown>> = [];
	const fakeRegistry = {
		start: (params: Record<string, unknown>) => {
			starts.push(params);
			return { id: 1, pid: 123, label: "ps", command: params.command, shell: "pwsh", status: "running", timeoutMs: 0 };
		},
		status: () => [],
		output: () => undefined,
		kill: () => undefined,
		listForeign: () => [],
	} as unknown as TaskRegistry;
	const tool = powershellBgTool({
		registry: fakeRegistry,
		resolvePowerShell: () => ({
			name: "pwsh",
			bin: "pwsh.exe",
			flavor: "powershell",
			args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
		}),
	}) as unknown as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
	const result = await tool.execute("call-1", { command: "Get-Date", timeout_sec: 12, detach: true });
	assert.equal(starts.length, 1);
	assert.equal((starts[0].shell as { name: string }).name, "pwsh");
	assert.equal(starts[0].timeoutMs, 12000);
	assert.equal(starts[0].detach, true);
	assert.match(result.content[0].text, /Started background task #1 \(pwsh, pid 123\)/);
});
