import assert from "node:assert/strict";
import test from "node:test";
import {
	BG_STATUS_WIDGET_KEY,
	BgStatusBar,
	formatElapsed,
	formatStatusBarLines,
	type WidgetTimer,
} from "../extensions/bg-shell/status-bar.ts";
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
		pattern: undefined,
		reportEveryMs: undefined,
		detached: false,
		adopted: false,
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
		stdoutSpillPath: undefined,
		stderrSpillPath: undefined,
		...overrides,
	};
}

/** Recording fake timer — tests fire ticks by hand and observe start/stop. */
class FakeTimer implements WidgetTimer {
	setCalls = 0;
	clearCalls = 0;
	private handler: (() => void) | undefined;
	set(handler: () => void, _ms: number): unknown {
		this.setCalls += 1;
		this.handler = handler;
		return { marker: true };
	}
	clear(_handle: unknown): void {
		this.clearCalls += 1;
		this.handler = undefined;
	}
	fire(): void {
		this.handler?.();
	}
}

test("formatElapsed matches the subagent-fleet spacing", () => {
	assert.equal(formatElapsed(45), "45s");
	assert.equal(formatElapsed(65), "1m 5s");
	assert.equal(formatElapsed(3725), "1h 2m 5s");
});

test("formatStatusBarLines is undefined with no running tasks", () => {
	assert.equal(formatStatusBarLines([], Date.now()), undefined);
	assert.equal(formatStatusBarLines([snapshot({ status: "completed" })], Date.now()), undefined);
});

test("formatStatusBarLines renders header, tree row, and footer", () => {
	const now = Date.now();
	const lines = formatStatusBarLines([snapshot()], now);
	assert.ok(lines !== undefined);
	assert.equal(lines[0], "▶ bg · background");
	assert.match(lines[1] ?? "", /└─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 npm test · 1m 5s/);
	assert.equal(lines.at(-1), " 1 running · /bg panel");
});

test("formatStatusBarLines ignores finished snapshots mixed with running ones", () => {
	const lines = formatStatusBarLines(
		[snapshot({ status: "completed" }), snapshot({ id: 2, status: "running", label: "vite dev" })],
		Date.now(),
	);
	assert.ok(lines !== undefined);
	assert.equal(lines.filter((line) => line.includes("#")).length, 1);
	assert.match(lines[1] ?? "", /#2 vite dev/);
	assert.match(lines.at(-1) ?? "", /1 running/);
});

test("formatStatusBarLines uses ├── between rows and └─ on the last", () => {
	const lines = formatStatusBarLines(
		[snapshot(), snapshot({ id: 2, label: "vite dev", startedAt: Date.now() - 31_000 })],
		Date.now(),
	);
	assert.ok(lines !== undefined);
	assert.match(lines[1] ?? "", / ├─ /);
	assert.match(lines[2] ?? "", / └─ /);
});

test("formatStatusBarLines rotates the spinner with the tick phase", () => {
	const now = Date.now();
	const first = formatStatusBarLines([snapshot()], now, { tick: 0 });
	const second = formatStatusBarLines([snapshot()], now, { tick: 1 });
	assert.ok(first !== undefined && second !== undefined);
	assert.notEqual(first[1], second[1]);
});

test("formatStatusBarLines adds an activity subline under tasks with fresh output", () => {
	const lines = formatStatusBarLines([snapshot()], Date.now(), {
		activity: new Map([[1, 2150]]),
	});
	assert.ok(lines !== undefined);
	assert.match(lines[2] ?? "", /^ +⎿ ↓ \+2\.1k$/);
	// Subline follows the tree continuation of its parent row (└─ → blank).
	assert.match(lines[2] ?? "", /^ /);
});

test("formatStatusBarLines activity subline keeps the │ rail under a ├── row", () => {
	const lines = formatStatusBarLines(
		[snapshot(), snapshot({ id: 2, label: "vite dev" })],
		Date.now(),
		{ activity: new Map([[1, 512]]) },
	);
	assert.ok(lines !== undefined);
	assert.match(lines[2] ?? "", /^ │    ⎿ ↓ \+512 B$/);
});

test("formatStatusBarLines collapses fan-outs beyond six tasks", () => {
	const now = Date.now();
	const running = [1, 2, 3, 4, 5, 6, 7].map((id) => snapshot({ id, label: `job${id}` }));
	const lines = formatStatusBarLines(running, now);
	assert.ok(lines !== undefined);
	assert.match(lines.at(-2) ?? "", / └─ … \+1 more/);
	assert.ok(!lines.some((line) => line.includes("job7")));
	assert.match(lines.at(-1) ?? "", / 7 running/);
});

test("BgStatusBar starts ticking on first running task and paints below the editor", () => {
	const timer = new FakeTimer();
	const calls: { key: string; content: string[] | undefined; placement?: string }[] = [];
	const bar = new BgStatusBar({ timer });
	bar.bindUi({
		setWidget: (key, content, options) => calls.push({ key, content, placement: options?.placement }),
	});
	assert.equal(timer.setCalls, 0);
	bar.refresh([snapshot()]);
	assert.equal(timer.setCalls, 1);
	assert.equal(calls.at(-1)?.key, BG_STATUS_WIDGET_KEY);
	assert.equal(calls.at(-1)?.placement, "belowEditor");
	const painted = calls.at(-1)?.content?.[1] ?? "";
	timer.fire();
	assert.equal(calls.length, 3); // bind-clear, refresh-paint, tick-paint
	assert.notEqual(calls.at(-1)?.content?.[1] ?? "", painted); // spinner advanced
});

test("BgStatusBar stops the ticker when the running set empties", () => {
	const timer = new FakeTimer();
	const calls: { content: string[] | undefined }[] = [];
	const bar = new BgStatusBar({ timer });
	bar.bindUi({ setWidget: (_key, content) => calls.push({ content }) });
	bar.refresh([snapshot()]);
	bar.refresh([snapshot({ status: "completed", finishedAt: Date.now(), durationMs: 100 })]);
	assert.equal(timer.clearCalls, 1);
	assert.equal(calls.at(-1)?.content, undefined); // widget removed
});

test("BgStatusBar stops the ticker when the UI unbinds", () => {
	const timer = new FakeTimer();
	const bar = new BgStatusBar({ timer });
	bar.bindUi({ setWidget: () => undefined });
	bar.refresh([snapshot()]);
	bar.bindUi(undefined);
	assert.equal(timer.clearCalls, 1);
});

test("BgStatusBar surfaces grown output as an activity subline on the next tick", () => {
	const timer = new FakeTimer();
	const calls: string[][] = [];
	const bar = new BgStatusBar({ timer });
	bar.bindUi({
		setWidget: (_key, content) => {
			if (content) calls.push(content);
		},
	});
	bar.refresh([snapshot({ stdoutBytes: 1000 })]);
	assert.ok(!calls.at(-1)?.some((line) => line.includes("⎿"))); // no baseline yet
	bar.refresh([snapshot({ stdoutBytes: 3150 })]); // grew 2150 since last paint
	assert.ok(calls.at(-1)?.some((line) => line.includes("⎿ ↓ +2.1k")));
});

test("BgStatusBar without a UI remembers running tasks for a late bind", () => {
	const timer = new FakeTimer();
	const calls: { content: string[] | undefined }[] = [];
	const bar = new BgStatusBar({ timer });
	bar.refresh([snapshot()]);
	assert.equal(calls.length, 0); // headless: no crash, no paint
	assert.equal(timer.setCalls, 0); // and no ticker against a dead surface
	bar.bindUi({ setWidget: (_key, content) => calls.push({ content }) });
	assert.equal(calls.length, 1);
	assert.match(calls[0].content?.[1] ?? "", /#1 npm test/);
	assert.equal(timer.setCalls, 1); // late bind starts the ticker
});

test("BgStatusBar.clear removes the widget and stops the ticker", () => {
	const timer = new FakeTimer();
	const calls: { content: string[] | undefined }[] = [];
	const bar = new BgStatusBar({ timer });
	bar.bindUi({ setWidget: (_key, content) => calls.push({ content }) });
	bar.refresh([snapshot()]);
	bar.clear();
	assert.equal(calls.at(-1)?.content, undefined);
	assert.equal(timer.clearCalls, 1);
});
