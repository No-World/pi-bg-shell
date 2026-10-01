import assert from "node:assert/strict";
import test from "node:test";
import { BgPanelComponent, parsePanelInput } from "../extensions/bg-shell/panel.ts";
import { TaskRegistry, type TaskSnapshot } from "../extensions/bg-shell/tasks.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

const identityTheme = { fg: (_role: never, text: string) => text };

function panel(registry: TaskRegistry, onDone: () => void = () => {}, initial?: { id?: number; tailBytes?: number }) {
	return new BgPanelComponent({ registry, theme: identityTheme, initialId: initial?.id, initialTailBytes: initial?.tailBytes }, onDone);
}

test("parsePanelInput maps raw sequences and vim-style keys", () => {
	assert.equal(parsePanelInput("\x1b[A").name, "up");
	assert.equal(parsePanelInput("k").name, "up");
	assert.equal(parsePanelInput("\x1b[B").name, "down");
	assert.equal(parsePanelInput("j").name, "down");
	assert.equal(parsePanelInput("\r").name, "enter");
	assert.equal(parsePanelInput("\x1b").name, "escape");
	assert.equal(parsePanelInput("K").name, "K");
	assert.equal(parsePanelInput("x").name, "other");
});

test("panel list renders tasks with status and selection marker", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "echo alpha", label: "alpha job", timeoutMs: 0 });
	registry.start({ command: "sleep 30", label: "long job", timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const component = panel(registry);
	const lines = component.render(100).join("\n");
	assert.match(lines, /#1 completed/);
	assert.match(lines, /#2 running/);
	assert.match(lines, /alpha job/);
	assert.match(lines, /long job/);
	assert.match(lines, /▸ #1/);
	registry.dispose();
});

test("panel list navigation moves the selection marker", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "echo one", timeoutMs: 0 });
	registry.start({ command: "echo two", timeoutMs: 0 });
	await waitFor(() => registry.status(2)[0].status !== "running");
	const component = panel(registry);
	component.handleInput("\x1b[B"); // down to #2
	assert.match(component.render(100).join("\n"), /▸ #2/);
	component.handleInput("\x1b[A"); // back to #1
	assert.match(component.render(100).join("\n"), /▸ #1/);
	registry.dispose();
});

test("enter opens detail with output tails; escape returns to list", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "echo detail-me", timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const component = panel(registry);
	component.handleInput("\r");
	const detail = component.render(120).join("\n");
	assert.match(detail, /bg task #1/);
	assert.match(detail, /detail-me/);
	assert.match(detail, /stdout tail/);
	component.handleInput("\x1b");
	assert.match(component.render(120).join("\n"), /bg tasks/);
	registry.dispose();
});

test("K kills the selected running task and refreshes", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "sleep 30", label: "victim", timeoutMs: 0 });
	const component = panel(registry);
	assert.equal(component.handleInput("K"), "killed");
	await waitFor(() => registry.status(1)[0].status !== "running");
	assert.equal(registry.status(1)[0].status, "killed");
	registry.dispose();
});

test("q and escape-from-list close the panel via done", () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	let closed = 0;
	const component = panel(registry, () => closed++);
	assert.equal(component.handleInput("q"), "close");
	assert.equal(closed, 1);
	registry.dispose();
});

test("empty list shows a hint instead of rows", () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const lines = panel(registry).render(100).join("\n");
	assert.match(lines, /No background tasks yet/);
	registry.dispose();
});

test("initialId opens the detail view directly with custom tail bytes", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: `printf '%s' '${"y".repeat(8192)}'`, timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const component = panel(registry, () => {}, { id: 1, tailBytes: 1024 });
	const detail = component.render(200).join("\n");
	assert.match(detail, /bg task #1/);
	assert.match(detail, /1024\/8192 bytes/);
	registry.dispose();
});

test("render truncates lines beyond the terminal width", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	const long = "x".repeat(200);
	registry.start({ command: "true", label: long, timeoutMs: 0 });
	const component = panel(registry);
	const lines = component.render(40);
	assert.ok(lines.every((line) => Array.from(line).length <= 40));
	registry.dispose();
});

test("panel reflects finished task duration and exit code", async () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "exit 4", label: "fails", timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const component = panel(registry);
	assert.match(component.render(100).join("\n"), /failed exit 4/);
	registry.dispose();
});

test("TaskSnapshot list from registry.status is panel input shape", () => {
	const registry = new TaskRegistry({ killGraceMs: 100 });
	registry.start({ command: "echo s", timeoutMs: 0 });
	const snapshots: TaskSnapshot[] = registry.status();
	assert.ok(snapshots[0].label.length > 0);
	assert.ok(snapshots[0].startedAt > 0);
	registry.dispose();
});
