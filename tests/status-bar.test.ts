import assert from "node:assert/strict";
import test from "node:test";
import { BG_STATUS_WIDGET_KEY, BgStatusBar, formatStatusBarLines } from "../extensions/bg-shell/status-bar.ts";
import type { TaskSnapshot } from "../extensions/bg-shell/tasks.ts";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: 1,
		label: "npm test",
		command: "npm test",
		cwd: "/repo",
		pid: 100,
		status: "running",
		exitCode: null,
		signal: null,
		errorMessage: undefined,
		startedAt: Date.now() - 65_000,
		finishedAt: undefined,
		durationMs: undefined,
		timeoutMs: 600000,
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
		stdoutSpillPath: undefined,
		stderrSpillPath: undefined,
		...overrides,
	};
}

test("formatStatusBarLines is undefined with no running tasks", () => {
	assert.equal(formatStatusBarLines([], Date.now()), undefined);
	assert.equal(formatStatusBarLines([snapshot({ status: "completed" })], Date.now()), undefined);
});

test("formatStatusBarLines ignores finished snapshots mixed with running ones", () => {
	const lines = formatStatusBarLines(
		[snapshot({ status: "completed" }), snapshot({ id: 2, status: "running" })],
		Date.now(),
	);
	assert.ok(lines !== undefined);
	assert.match(lines[0], /▶ bg 1 running/);
	assert.match(lines[0], /#2 npm test/);
});

test("formatStatusBarLines shows count, labels, and elapsed time", () => {
	const now = Date.now();
	const lines = formatStatusBarLines([snapshot()], now);
	assert.ok(lines !== undefined);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /▶ bg 1 running/);
	assert.match(lines[0], /#1 npm test \(1m0/);
	assert.match(lines[0], /\/bg panel/);
});

test("formatStatusBarLines collapses fan-outs beyond three tasks", () => {
	const now = Date.now();
	const running = [1, 2, 3, 4, 5].map((id) => snapshot({ id, label: `job${id}` }));
	const lines = formatStatusBarLines(running, now);
	assert.ok(lines !== undefined);
	assert.match(lines[0], /▶ bg 5 running/);
	assert.match(lines[0], /\+2 more/);
	assert.ok(!lines[0].includes("job4"));
});

test("BgStatusBar paints and clears the widget through the UI", () => {
	const calls: { key: string; content: string[] | undefined; placement?: string }[] = [];
	const ui = {
		setWidget: (key: string, content: string[] | undefined, options?: { placement?: string }) => {
			calls.push({ key, content, placement: options?.placement });
		},
	};
	const bar = new BgStatusBar();
	bar.bindUi(ui); // immediate clear-paint: one undefined call
	assert.equal(calls.length, 1);
	assert.equal(calls[0].content, undefined);
	bar.refresh([snapshot()]);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].key, BG_STATUS_WIDGET_KEY);
	assert.equal(calls[1].placement, "aboveEditor");
	assert.match(calls[1].content?.[0] ?? "", /▶ bg 1 running/);
	bar.refresh([snapshot({ status: "completed", finishedAt: Date.now(), durationMs: 100 })]);
	const last = calls.at(-1);
	assert.equal(last?.content, undefined);
});

test("BgStatusBar without a UI remembers running tasks for a late bind", () => {
	const calls: { key: string; content: string[] | undefined }[] = [];
	const bar = new BgStatusBar();
	bar.refresh([snapshot()]);
	assert.equal(calls.length, 0); // headless: no crash, no paint
	bar.bindUi({
		setWidget: (key, content) => calls.push({ key, content }),
	});
	assert.equal(calls.length, 1);
	assert.match(calls[0].content?.[0] ?? "", /▶ bg 1 running/);
});

test("BgStatusBar.clear removes the widget", () => {
	const calls: { content: string[] | undefined }[] = [];
	const bar = new BgStatusBar();
	bar.bindUi({ setWidget: (_key, content) => calls.push({ content }) });
	bar.refresh([snapshot()]);
	bar.clear();
	assert.equal(calls.at(-1)?.content, undefined);
});
