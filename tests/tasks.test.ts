import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultTimeoutMsFromEnv, LineMatcher, OutputBuffer, TaskRegistry, type RunningEvent, type TaskOutput, type TaskSnapshot } from "../extensions/bg-shell/tasks.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-bg-shell-test-${prefix}-`));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

function freshRegistry(overrides: Partial<ConstructorParameters<typeof TaskRegistry>[0]> = {}): TaskRegistry {
	return new TaskRegistry({ killGraceMs: 100, ...overrides });
}

test("OutputBuffer keeps everything under the limit and never spills", () => {
	const buffer = new OutputBuffer(1024, join(tempDir("nospill"), "never.log"));
	buffer.append(Buffer.from("hello "));
	buffer.append(Buffer.from("world"));
	assert.equal(buffer.byteLength, 11);
	assert.equal(buffer.tail(1024), "hello world");
	assert.equal(buffer.truncated, false);
	assert.equal(buffer.spillPath, undefined);
});

test("OutputBuffer spills full history on first overflow and keeps the tail in memory", () => {
	const dir = tempDir("spill");
	const spillPath = join(dir, "out.log");
	const buffer = new OutputBuffer(8, spillPath);
	buffer.append(Buffer.from("0123456789")); // already over the limit → spill
	assert.equal(buffer.truncated, true);
	assert.equal(buffer.spillPath, spillPath);
	assert.equal(buffer.byteLength, 10);
	// Memory keeps only the tail once the spill exists.
	assert.equal(buffer.tail(4), "6789");
	// Spill file is owner-only (0600), matching the CodeQL hardening.
	const mode = statSync(spillPath).mode & 0o777;
	assert.equal(mode, 0o600);
	// dispose is idempotent and removes the file.
	buffer.dispose();
	buffer.dispose();
	assert.ok(!existsSync(spillPath));
});

test("OutputBuffer falls back to bounded lossy memory when the spill path is taken", () => {
	const dir = tempDir("lossy");
	const spillPath = join(dir, "out.log");
	writeFileSync(spillPath, "leftover from a crashed run"); // wx must refuse this
	const buffer = new OutputBuffer(8, spillPath);
	for (let i = 0; i < 100; i++) buffer.append(Buffer.from("0123456789"));
	assert.equal(buffer.truncated, true); // lossy, not spilled
	assert.equal(buffer.spillPath, undefined);
	assert.equal(buffer.byteLength, 1000);
	// Bounded memory: tail stays near the limit instead of growing unbounded.
	assert.ok(buffer.tail(1000).length <= 32);
	buffer.dispose();
});

test("start returns a running snapshot and completes with exit 0", async () => {
	const registry = freshRegistry();
	const snapshot = registry.start({ command: "echo hello", timeoutMs: 0 });
	assert.equal(snapshot.status, "running");
	assert.ok(snapshot.pid !== undefined);
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const finished = registry.status(snapshot.id)[0];
	assert.equal(finished.status, "completed");
	assert.equal(finished.exitCode, 0);
	const output = registry.output(snapshot.id);
	assert.equal(output?.stdoutTail.trim(), "hello");
	registry.dispose();
});

test("non-zero exit marks the task failed and captures stderr", async () => {
	const registry = freshRegistry();
	const snapshot = registry.start({ command: "echo oops >&2; exit 3" });
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const finished = registry.status(snapshot.id)[0];
	assert.equal(finished.status, "failed");
	assert.equal(finished.exitCode, 3);
	assert.equal(registry.output(snapshot.id)?.stderrTail.trim(), "oops");
	registry.dispose();
});

test("timeout kills the task and reports status timeout", async () => {
	const registry = freshRegistry();
	const snapshot = registry.start({ command: "sleep 30", timeoutMs: 150 });
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const finished = registry.status(snapshot.id)[0];
	assert.equal(finished.status, "timeout");
	registry.dispose();
});

test("kill marks the task killed with the user signal", async () => {
	const registry = freshRegistry();
	const snapshot = registry.start({ command: "sleep 30", timeoutMs: 0 });
	registry.kill(snapshot.id, "SIGKILL");
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	assert.equal(registry.status(snapshot.id)[0].status, "killed");
	registry.dispose();
});

test("spawn failure with a bad cwd finalizes as failed without hanging", async () => {
	const registry = freshRegistry();
	const snapshot = registry.start({ command: "echo hi", cwd: "/nonexistent-dir-for-bg-shell-test" });
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const finished = registry.status(snapshot.id)[0];
	assert.equal(finished.status, "failed");
	assert.ok(finished.errorMessage !== undefined && finished.errorMessage.length > 0);
	registry.dispose();
});

test("empty command is rejected", () => {
	const registry = freshRegistry();
	assert.throws(() => registry.start({ command: "   " }), /non-empty/);
	registry.dispose();
});

test("output beyond the buffer spills to a file with the full history", async () => {
	const registry = freshRegistry({ maxBufferBytes: 64 });
	const payload = "x".repeat(300);
	const snapshot = registry.start({ command: `printf '%s' '${payload}'`, timeoutMs: 0 });
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const finished = registry.status(snapshot.id)[0];
	assert.equal(finished.status, "completed");
	assert.equal(finished.stdoutTruncated, true);
	assert.ok(finished.stdoutSpillPath !== undefined);
	assert.ok(existsSync(finished.stdoutSpillPath));
	assert.equal(readFileSync(finished.stdoutSpillPath, "utf8"), payload);
	const output = registry.output(snapshot.id, 32);
	assert.equal(output?.stdoutTail.length, 32);
	assert.match(output?.stdoutTail ?? "", /^x+$/);
	registry.dispose();
});

test("ids increment and onExit fires once per task with the final snapshot", async () => {
	const registry = freshRegistry();
	const exits: number[] = [];
	registry.onExit = (snapshot) => exits.push(snapshot.id);
	const first = registry.start({ command: "true" });
	const second = registry.start({ command: "true" });
	assert.equal(second.id, first.id + 1);
	await waitFor(() => registry.status(second.id)[0].status !== "running");
	assert.deepEqual(exits.sort(), [first.id, second.id]);
	registry.dispose();
});

test("finished tasks beyond retainFinished are evicted and their spills removed", async () => {
	const registry = freshRegistry({ retainFinished: 1, maxBufferBytes: 16 });
	const first = registry.start({ command: `printf '%s' '${"a".repeat(64)}'`, timeoutMs: 0 });
	await waitFor(() => registry.status(first.id)[0].status !== "running");
	const firstSpill = registry.status(first.id)[0].stdoutSpillPath;
	assert.ok(firstSpill !== undefined);
	const second = registry.start({ command: "true" });
	await waitFor(() => registry.status(second.id)[0].status !== "running");
	// First task evicted: status empty, spill file gone.
	assert.deepEqual(registry.status(first.id), []);
	assert.ok(!existsSync(firstSpill));
	// The retained task is still queryable.
	assert.equal(registry.status(second.id)[0].status, "completed");
	registry.dispose();
});

test("status() without id lists every task, oldest first", async () => {
	const registry = freshRegistry();
	registry.start({ command: "true", timeoutMs: 0 });
	registry.start({ command: "sleep 30", timeoutMs: 0 });
	await waitFor(() => registry.status(1)[0].status !== "running");
	const all = registry.status();
	assert.equal(all.length, 2);
	assert.equal(all[0].id, 1);
	assert.equal(all[0].status, "completed");
	assert.equal(all[1].status, "running");
	registry.dispose();
});

test("killAll terminates every running task", async () => {
	const registry = freshRegistry();
	const one = registry.start({ command: "sleep 30", timeoutMs: 0 });
	const two = registry.start({ command: "sleep 30", timeoutMs: 0 });
	registry.killAll("SIGKILL");
	await waitFor(() => registry.runningCount === 0);
	assert.equal(registry.status(one.id)[0].status, "killed");
	assert.equal(registry.status(two.id)[0].status, "killed");
	registry.dispose();
});

test("LineMatcher fires on completed lines across chunk splits and strips CR", () => {
	const hits: Array<{ line: string; stream: string }> = [];
	const matcher = new LineMatcher("ROOTED", (line, stream) => hits.push({ line, stream }));
	matcher.feed(Buffer.from("prelude\npartial RO"), "stdout");
	assert.equal(hits.length, 0, "no newline yet — nothing complete to match");
	matcher.feed(Buffer.from("OTED device 3\r\n"), "stdout");
	assert.deepEqual(hits, [{ line: "partial ROOTED device 3", stream: "stdout" }]);
	matcher.feed(Buffer.from("noise\n"), "stderr");
	assert.equal(hits.length, 1, "non-matching lines do not fire");
	matcher.feed(Buffer.from("ROOTED on stderr\n"), "stderr");
	assert.equal(hits.length, 2);
	assert.equal(hits[1]?.stream, "stderr");
});

test("LineMatcher tests very long unterminated lines once past the cap", () => {
	const hits: string[] = [];
	const matcher = new LineMatcher("needle", (line) => hits.push(line));
	matcher.feed(Buffer.from("x".repeat(70_000) + "needle"), "stdout");
	assert.equal(hits.length, 1, "cap flush forces a mid-line test");
	assert.ok(hits[0]!.includes("needle"));
});

test("on_pattern wakes once per task while later matches still count", async () => {
	const registry = freshRegistry();
	const events: RunningEvent[] = [];
	registry.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	const snapshot = registry.start({
		command: "echo pre; sleep 0.15; echo ROOTED one; sleep 0.15; echo ROOTED two; sleep 0.1",
		timeoutMs: 0,
		pattern: { literal: "ROOTED" },
	});
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const fired = events.filter((event) => event.kind === "pattern");
	assert.equal(fired.length, 1, "single-shot fires exactly once");
	assert.equal(fired[0]?.line, "ROOTED one");
	assert.equal(registry.status(snapshot.id)[0].pattern?.matches, 2, "counting continues after the fire");
	assert.equal(registry.status(snapshot.id)[0].status, "completed");
	registry.dispose();
});

test("on_pattern with all fires per match under the rate limit and saturates above it", async () => {
	const registry = freshRegistry();
	const events: RunningEvent[] = [];
	registry.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	const snapshot = registry.start({
		command: "echo HIT a; sleep 0.1; echo HIT b; echo HIT c; sleep 0.1",
		timeoutMs: 0,
		pattern: { literal: "HIT", all: true, minFireIntervalMs: 60_000 },
	});
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	assert.equal(events.filter((event) => event.kind === "pattern").length, 1, "log floods are rate-limited");
	assert.equal(registry.status(snapshot.id)[0].pattern?.matches, 3);
	registry.dispose();

	const free = freshRegistry();
	const fired: RunningEvent[] = []
	free.onRunningEvent = (_snapshot, _output, event) => fired.push(event);
	const second = free.start({
		command: "echo HIT a; sleep 0.1; echo HIT b; sleep 0.1; echo HIT c; sleep 0.1",
		timeoutMs: 0,
		pattern: { literal: "HIT", all: true, minFireIntervalMs: 0 },
	});
	await waitFor(() => free.status(second.id)[0].status !== "running");
	assert.equal(fired.filter((event) => event.kind === "pattern").length, 3, "zero interval lets every match through");
	free.dispose();
});

test("on_pattern with stop delivers the match and then kills the task", async () => {
	const registry = freshRegistry();
	const events: RunningEvent[] = [];
	registry.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	const snapshot = registry.start({
		command: "sleep 0.2; echo DONE; sleep 30",
		timeoutMs: 0,
		pattern: { literal: "DONE", stop: true },
	});
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	assert.equal(events.filter((event) => event.kind === "pattern").length, 1, "match delivered first");
	assert.equal(events[0]?.line, "DONE");
	assert.equal(registry.status(snapshot.id)[0].status, "killed", "task stopped via the kill path");
	registry.dispose();
});

test("report_every delivers progress while running and stops at exit", async () => {
	const registry = freshRegistry();
	const events: RunningEvent[] = [];
	registry.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	const snapshot = registry.start({ command: "sleep 1", timeoutMs: 0, reportEveryMs: 150 });
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const reports = events.filter((event) => event.kind === "report");
	assert.ok(reports.length >= 2, `expected >= 2 reports, got ${reports.length}`);
	registry.dispose();
});

test("empty pattern literal is rejected", () => {
	const registry = freshRegistry();
	assert.throws(() => registry.start({ command: "true", pattern: { literal: "" } }), /non-empty/);
	registry.dispose();
});

test("defaultTimeoutMsFromEnv parses PI_BG_SHELL_TIMEOUT_SEC with safe fallbacks", () => {
	const fallback = 123_000;
	assert.equal(defaultTimeoutMsFromEnv({}, fallback), fallback, "missing → fallback");
	assert.equal(defaultTimeoutMsFromEnv({ PI_BG_SHELL_TIMEOUT_SEC: "" }, fallback), fallback, "empty → fallback");
	assert.equal(defaultTimeoutMsFromEnv({ PI_BG_SHELL_TIMEOUT_SEC: " 3600 " }, fallback), 3_600_000, "trimmed numeric → ms");
	assert.equal(defaultTimeoutMsFromEnv({ PI_BG_SHELL_TIMEOUT_SEC: "0" }, fallback), 0, "0 disables the default");
	assert.equal(defaultTimeoutMsFromEnv({ PI_BG_SHELL_TIMEOUT_SEC: "12.5" }, fallback), 12_500, "fractional seconds allowed");
	for (const bad of ["abc", "-5", "NaN", "Infinity"]) {
		assert.equal(
			defaultTimeoutMsFromEnv({ PI_BG_SHELL_TIMEOUT_SEC: bad }, fallback),
			fallback,
			`${bad} → fallback`,
		);
	}
});
