import assert from "node:assert/strict";
import test from "node:test";
import { parseBgArgs, registerBgCommand, type PanelHostUi } from "../extensions/bg-shell/command.ts";
import { TaskRegistry } from "../extensions/bg-shell/tasks.ts";

function stubPi() {
	const commands: {
		name: string;
		description: string | undefined;
		getArgumentCompletions?: (prefix: string) => unknown;
		handler: (args: string, ctx: unknown) => Promise<void>;
	}[] = [];
	return {
		commands,
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }) {
			commands.push({ name, description: options.description, getArgumentCompletions: options.getArgumentCompletions, handler: options.handler });
		},
	};
}

function stubCtx(mode = "tui") {
	const notifications: { message: string; type?: string }[] = [];
	const panels: { initial?: { id?: number; tailBytes?: number } }[] = [];
	const ui: PanelHostUi = {
		notify: (message, type) => notifications.push({ message, type }),
		custom: (async () => undefined) as unknown as PanelHostUi["custom"],
	};
	return {
		ctx: { mode, hasUI: mode === "tui", ui },
		notifications,
		panels,
		ui,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

test("parseBgArgs covers every accepted shape", () => {
	assert.deepEqual(parseBgArgs(""), { kind: "panel" });
	assert.deepEqual(parseBgArgs("  "), { kind: "panel" });
	assert.deepEqual(parseBgArgs("3"), { kind: "detail", id: 3 });
	assert.deepEqual(parseBgArgs("#7"), { kind: "detail", id: 7 });
	assert.deepEqual(parseBgArgs("tail 2"), { kind: "tail", id: 2, bytes: undefined });
	assert.deepEqual(parseBgArgs("tail 2 8192"), { kind: "tail", id: 2, bytes: 8192 });
	assert.deepEqual(parseBgArgs("kill 5"), { kind: "kill", id: 5, signal: undefined });
	assert.deepEqual(parseBgArgs("kill 5 SIGKILL"), { kind: "kill", id: 5, signal: "SIGKILL" });
	assert.deepEqual(parseBgArgs("log 1"), { kind: "log", id: 1 });
	assert.deepEqual(parseBgArgs("bogus"), { kind: "usage", error: 'unknown subcommand "bogus"' });
	assert.equal(parseBgArgs("tail").kind, "usage");
	assert.equal(parseBgArgs("kill 1 SIGSTOP").kind, "usage");
	assert.equal(parseBgArgs("tail 1 -5").kind, "usage");
});

test("parseBgArgs usage errors carry helpful text", () => {
	const bad = parseBgArgs("tail");
	assert.equal(bad.kind, "usage");
	if (bad.kind === "usage") assert.match(bad.error ?? "", /tail needs a task id/);
	const badSignal = parseBgArgs("kill 1 SIGSTOP");
	assert.equal(badSignal.kind, "usage");
	if (badSignal.kind === "usage") assert.match(badSignal.error ?? "", /unknown signal/);
});

test("all info subcommands open the panel, never notify the transcript", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "echo panel-me", timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const pi = stubPi();
	const opened: ({ id?: number; tailBytes?: number } | undefined)[] = [];
	registerBgCommand(pi as never, { registry, openPanel: (_ctx, initial) => opened.push(initial) });
	const { ctx } = stubCtx();

	await pi.commands[0].handler("", ctx);
	await pi.commands[0].handler("1", ctx);
	await pi.commands[0].handler("tail 1 2048", ctx);
	await pi.commands[0].handler("log 1", ctx);

	assert.deepEqual(opened, [undefined, { id: 1 }, { id: 1, tailBytes: 2048 }, { id: 1 }]);
	registry.dispose();
});

test("kill subcommand terminates a running task and notifies the ack", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "sleep 30", timeoutMs: 0 });
	const pi = stubPi();
	registerBgCommand(pi as never, { registry, openPanel: () => {} });
	const { ctx, notifications } = stubCtx();

	await pi.commands[0].handler("kill 1", ctx);
	assert.match(notifications[0].message, /Sent SIGTERM to task #1/);
	await waitFor(() => registry.status(1)[0].status !== "running");
	assert.equal(registry.status(1)[0].status, "killed");

	notifications.length = 0;
	await pi.commands[0].handler("kill 1", ctx);
	assert.match(notifications[0].message, /already killed/);
	registry.dispose();
});

test("unknown id warns and no panel opens", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const pi = stubPi();
	let opened = 0;
	registerBgCommand(pi as never, { registry, openPanel: () => opened++ });
	const { ctx, notifications } = stubCtx();
	await pi.commands[0].handler("42", ctx);
	assert.equal(opened, 0);
	assert.match(notifications[0].message, /No background task with id 42/);
	registry.dispose();
});

test("usage errors surface the command family cheat-sheet", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const pi = stubPi();
	registerBgCommand(pi as never, { registry, openPanel: () => {} });
	const { ctx, notifications } = stubCtx();
	await pi.commands[0].handler("wat", ctx);
	assert.match(notifications[0].message, /\/bg usage:/);
	assert.match(notifications[0].message, /wat/);
	registry.dispose();
});

test("completions offer subcommands and task ids", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "echo c1", label: "completion job", timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const pi = stubPi();
	registerBgCommand(pi as never, { registry, openPanel: () => {} });
	const completions = pi.commands[0].getArgumentCompletions?.("") as { value: string; label: string }[];
	assert.ok(completions.some((item) => item.value === "kill "));
	assert.ok(completions.some((item) => item.value === "tail "));
	const idCompletions = pi.commands[0].getArgumentCompletions?.("1") as { value: string; label: string }[];
	assert.ok(idCompletions.some((item) => item.label === "#1"));
	assert.equal(pi.commands[0].getArgumentCompletions?.("zz"), null);
	registry.dispose();
});
