import assert from "node:assert/strict";
import test from "node:test";
import {
	BG_STATUS_WIDGET_KEY,
	BgStatusBar,
	formatBudget,
	formatElapsed,
	formatStatusBarLines,
	truncateStyled,
	type StatusTheme,
	type TaskActivity,
	type WidgetComponent,
	type WidgetTimer,
} from "../extensions/bg-shell/status-bar.ts";
import type { TaskSnapshot } from "../extensions/bg-shell/tasks.ts";

/** Identity theme — plain-text assertions; roles recorded for color tests. */
function plainTheme(): StatusTheme & { roles: string[] } {
	const roles: string[] = [];
	return {
		roles,
		fg: (role, text) => {
			roles.push(role);
			return text;
		},
	};
}

function activity(overrides: Partial<TaskActivity> = {}): TaskActivity {
	return { totalBytes: 0, lastLine: "", ...overrides };
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: 1,
		label: "npm test",
		command: "npm test",
	shell: "bash",
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

const WIDE = 200;

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

/** Factory-form fake ui: captures registrations, hands back fake tui + theme. */
class FakeUi {
	setCalls: { key: string; kind: "factory" | "undefined" | "lines"; placement?: string }[] = [];
	renders = 0;
	requests = 0;
	theme = plainTheme();
	component: WidgetComponent | undefined;
	setWidget: (key: string, content: unknown, options?: { placement?: string }) => void = (key, content, options) => {
		if (content === undefined) {
			this.setCalls.push({ key, kind: "undefined" });
			this.component = undefined;
			return;
		}
		if (typeof content === "function") {
			this.setCalls.push({ key, kind: "factory", placement: options?.placement });
			this.component = content(
				{ requestRender: () => (this.requests += 1) },
				this.theme as StatusTheme,
			);
			return;
		}
		this.setCalls.push({ key, kind: "lines" });
	};
	render(width = WIDE): string[] {
		this.renders += 1;
		return this.component?.render(width) ?? [];
	}
}

test("formatElapsed matches the subagent-fleet spacing", () => {
	assert.equal(formatElapsed(45), "45s");
	assert.equal(formatElapsed(65), "1m 5s");
	assert.equal(formatElapsed(3725), "1h 2m 5s");
});

test("formatBudget trims zero units at every scale", () => {
	assert.equal(formatBudget(0), "0s");
	assert.equal(formatBudget(45_000), "45s");
	assert.equal(formatBudget(59_999), "59s");
	assert.equal(formatBudget(300_000), "5m");
	assert.equal(formatBudget(270_000), "4m 30s");
	assert.equal(formatBudget(7_200_000), "2h");
	assert.equal(formatBudget(7_500_000), "2h 5m");
});

test("formatStatusBarLines appends the timeout budget only when one is armed", () => {
	const theme = plainTheme();
	const armed = formatStatusBarLines(
		{ running: [snapshot()], now: Date.now(), tick: 0, activity: new Map() },
		theme,
		WIDE,
	);
	assert.match(armed?.[1] ?? "", /1m 5s \/ 10m$/);
	const unlimited = formatStatusBarLines(
		{ running: [snapshot({ timeoutMs: 0 })], now: Date.now(), tick: 0, activity: new Map() },
		theme,
		WIDE,
	);
	assert.match(unlimited?.[1] ?? "", /1m 5s$/);
	assert.ok(!(unlimited?.[1] ?? "").includes("/"));
});

test("formatStatusBarLines is undefined with no running tasks", () => {
	const theme = plainTheme();
	assert.equal(formatStatusBarLines({ running: [], now: Date.now(), tick: 0, activity: new Map() }, theme, WIDE), undefined);
	assert.equal(
		formatStatusBarLines(
			{ running: [snapshot({ status: "completed" })], now: Date.now(), tick: 0, activity: new Map() },
			theme,
			WIDE,
		),
		undefined,
	);
});

test("formatStatusBarLines renders the card layout: header, row, cmd, footer", () => {
	const theme = plainTheme();
	const lines = formatStatusBarLines(
		{ running: [snapshot()], now: Date.now(), tick: 0, activity: new Map() },
		theme,
		WIDE,
	);
	assert.ok(lines !== undefined);
	assert.equal(lines[0], "bg · background");
	assert.match(lines[1] ?? "", /^   [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 npm test · running · 1m 5s \/ 10m$/);
	assert.equal(lines[2], "     cmd: npm test");
	assert.equal(lines.at(-1), " 1 running · /bg panel");
	// No output yet → no ⎿ activity line.
	assert.ok(!lines.some((line) => line.includes("⎿")));
});

test("formatStatusBarLines ignores finished snapshots mixed with running ones", () => {
	const theme = plainTheme();
	const lines = formatStatusBarLines(
		{
			running: [snapshot({ status: "completed" }), snapshot({ id: 2, label: "vite dev" })].filter(
				(task) => task.status === "running",
			),
			now: Date.now(),
			tick: 0,
			activity: new Map(),
		},
		theme,
		WIDE,
	);
	assert.ok(lines !== undefined);
	assert.equal(lines.filter((line) => line.includes("#")).length, 1);
	assert.match(lines[1] ?? "", /#2 vite dev/);
});

test("formatStatusBarLines rotates the spinner with the tick phase", () => {
	const theme = plainTheme();
	const state = (tick: number) => ({
		running: [snapshot()],
		now: Date.now(),
		tick,
		activity: new Map<number, TaskActivity>(),
	});
	const first = formatStatusBarLines(state(0), theme, WIDE);
	const second = formatStatusBarLines(state(1), theme, WIDE);
	assert.ok(first !== undefined && second !== undefined);
	assert.notEqual(first[1], second[1]);
});

test("formatStatusBarLines adds a ⎿ activity line with total bytes and last output", () => {
	const theme = plainTheme();
	const lines = formatStatusBarLines(
		{
			running: [snapshot({ stdoutBytes: 18_400, stderrBytes: 0 })],
			now: Date.now(),
			tick: 0,
			activity: new Map([[1, activity({ totalBytes: 18_400, lastLine: "[00:19:48] chatty heartbeat #112" })]]),
		},
		theme,
		WIDE,
	);
	assert.ok(lines !== undefined);
	const subline = lines.find((line) => line.includes("⎿"));
	assert.ok(subline !== undefined);
	assert.match(subline, /↓ 18\.0k/);
	assert.match(subline, /chatty heartbeat #112/);
});

test("formatStatusBarLines collapses fan-outs beyond six tasks", () => {
	const theme = plainTheme();
	const running = [1, 2, 3, 4, 5, 6, 7].map((id) => snapshot({ id, label: `job${id}` }));
	const lines = formatStatusBarLines({ running, now: Date.now(), tick: 0, activity: new Map() }, theme, WIDE);
	assert.ok(lines !== undefined);
	assert.ok(lines.some((line) => line.includes("… +1 more")));
	assert.ok(!lines.some((line) => line.includes("job7")));
	assert.match(lines.at(-1) ?? "", / 7 running/);
});

test("truncateStyled cuts plain text with an ellipsis and respects width", () => {
	assert.equal(truncateStyled("hello world", 8), "hello w…");
	assert.equal(truncateStyled("short", 40), "short");
	assert.equal(truncateStyled("中文宽度测试", 5), "中文…"); // CJK counts double
});

test("truncateStyled keeps ANSI colors before the cut and resets after", () => {
	const styled = `\x1b[31m${"a".repeat(20)}\x1b[0m`;
	const cut = truncateStyled(styled, 10);
	assert.ok(cut.startsWith("\x1b[31m"));
	assert.ok(cut.endsWith("…\x1b[0m"));
	assert.ok(!cut.slice(0, -2).includes("\x1b[0m"));
});

test("formatStatusBarLines never exceeds the requested width", () => {
	const theme = plainTheme();
	const lines = formatStatusBarLines(
		{
			running: [snapshot({ label: "a-very-long-label".repeat(4), command: `echo ${"x".repeat(120)}` })],
			now: Date.now(),
			tick: 0,
			activity: new Map([[1, activity({ totalBytes: 9, lastLine: "y".repeat(120) })]]),
		},
		theme,
		40,
	);
	assert.ok(lines !== undefined);
	for (const line of lines) {
		const bare = line.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(bare.length <= 40, `line too long: ${bare.length}`);
	}
});

test("formatStatusBarLines colors roles per section", () => {
	const theme = plainTheme();
	formatStatusBarLines(
		{
			running: [snapshot()],
			now: Date.now(),
			tick: 0,
			activity: new Map([[1, activity({ totalBytes: 512, lastLine: "boom" })]]),
		},
		theme,
		WIDE,
	);
	// Header and task label stay uncolored (plain white) by design; only
	// chrome, stats, and output carry theme roles.
	assert.ok(theme.roles.includes("dim"));
	assert.ok(theme.roles.includes("muted"));
	assert.ok(theme.roles.includes("toolOutput"));
});

test("BgStatusBar registers a factory widget above the editor and ticks it", () => {
	const timer = new FakeTimer();
	const ui = new FakeUi();
	const bar = new BgStatusBar({ timer });
	bar.bindUi(ui);
	assert.equal(ui.setCalls.length, 0); // nothing running: no registration
	bar.refresh([snapshot()]);
	const registration = ui.setCalls.at(-1);
	assert.equal(registration?.key, BG_STATUS_WIDGET_KEY);
	assert.equal(registration?.kind, "factory");
	assert.equal(registration?.placement, "aboveEditor");
	assert.ok(ui.component !== undefined);
	const first = ui.render();
	assert.match(first[1] ?? "", /#1 npm test/);
	const spinnerBefore = first[1];
	timer.fire();
	assert.equal(ui.requests, 2); // refresh-sync + tick-sync both asked pi to repaint
	const second = ui.render();
	assert.notEqual(second[1], spinnerBefore); // spinner advanced
});

test("BgStatusBar feeds output tails into the activity line", () => {
	const timer = new FakeTimer();
	const ui = new FakeUi();
	let bytes = 1000;
	let tail = "[00:19:48] chatty heartbeat #112 ······ payload bytes flowing\n";
	const bar = new BgStatusBar({
		timer,
		getOutput: (id) =>
			id === 1
				? { stdoutTail: tail, stderrTail: "", stdoutBytes: bytes, stderrBytes: 0 }
				: undefined,
	});
	bar.bindUi(ui);
	bar.refresh([snapshot()]);
	let lines = ui.render();
	assert.ok(lines.some((line) => line.includes("chatty heartbeat #112")));
	bytes = 3150;
	tail += "[00:19:50] chatty heartbeat #113 ······ payload bytes flowing\n";
	timer.fire();
	lines = ui.render();
	const subline = lines.find((line) => line.includes("⎿"));
	assert.ok(subline !== undefined);
	assert.match(subline, /↓ 3\.1k/);
	assert.match(subline, /heartbeat #113/); // last line advanced
});

test("BgStatusBar animates strictly on the tick — foreign repaints draw the same frame", () => {
	const timer = new FakeTimer();
	const ui = new FakeUi();
	const bar = new BgStatusBar({ timer });
	bar.bindUi(ui);
	bar.refresh([snapshot({ startedAt: Date.now() - 65_000 })]);
	const first = ui.render();
	const foreign = ui.render(); // pi repainted for unrelated reasons
	assert.deepEqual(foreign, first); // same frozen frame: no spinner/elapsed drift
	timer.fire();
	const next = ui.render();
	assert.notDeepEqual(next, first); // only the 500 ms tick advances the frame
});

	test("BgStatusBar removes the widget and stops the ticker when tasks drain", () => {
	const timer = new FakeTimer();
	const ui = new FakeUi();
	const bar = new BgStatusBar({ timer });
	bar.bindUi(ui);
	bar.refresh([snapshot()]);
	bar.refresh([snapshot({ status: "completed", finishedAt: Date.now(), durationMs: 100 })]);
	assert.equal(ui.setCalls.at(-1)?.kind, "undefined");
	assert.equal(timer.clearCalls, 1);
});

test("BgStatusBar stops the ticker when the UI unbinds", () => {
	const timer = new FakeTimer();
	const ui = new FakeUi();
	const bar = new BgStatusBar({ timer });
	bar.bindUi(ui);
	bar.refresh([snapshot()]);
	bar.bindUi(undefined);
	assert.equal(timer.clearCalls, 1);
});

test("BgStatusBar re-registers on a fresh UI surface after a rebind", () => {
	const timer = new FakeTimer();
	const first = new FakeUi();
	const bar = new BgStatusBar({ timer });
	bar.bindUi(first);
	bar.refresh([snapshot()]);
	assert.equal(first.setCalls.filter((call) => call.kind === "factory").length, 1);
	const second = new FakeUi();
	bar.bindUi(second); // reload: new surface, same running set
	second.render();
	assert.equal(second.setCalls.filter((call) => call.kind === "factory").length, 1);
	assert.match(second.render()[1] ?? "", /#1 npm test/);
});

test("BgStatusBar without a UI remembers running tasks for a late bind", () => {
	const timer = new FakeTimer();
	const bar = new BgStatusBar({ timer });
	bar.refresh([snapshot()]);
	assert.equal(timer.setCalls, 0); // headless: no ticker against a dead surface
	const ui = new FakeUi();
	bar.bindUi(ui);
	assert.equal(ui.setCalls.filter((call) => call.kind === "factory").length, 1);
	assert.match(ui.render()[1] ?? "", /#1 npm test/);
	assert.equal(timer.setCalls, 1); // late bind starts the ticker
});

test("BgStatusBar.clear removes the widget and stops the ticker", () => {
	const timer = new FakeTimer();
	const ui = new FakeUi();
	const bar = new BgStatusBar({ timer });
	bar.bindUi(ui);
	bar.refresh([snapshot()]);
	bar.clear();
	assert.equal(ui.setCalls.at(-1)?.kind, "undefined");
	assert.equal(timer.clearCalls, 1);
});
