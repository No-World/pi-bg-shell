import assert from "node:assert/strict";
import type { ChildProcess, spawn as spawnType } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildWslDetachedWrapper, defaultTimeoutMsFromEnv, LineMatcher, OutputBuffer, TaskRegistry, toWslPath, type RunningEvent, type TaskOutput, type TaskSnapshot } from "../extensions/bg-shell/tasks.ts";

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

test("OutputBuffer spills full history on first overflow and keeps the tail in memory", { skip: "NTFS does not honor POSIX mode bits (Windows-node only)" }, () => {
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
	// includes, not equals: the WSL relay may prepend environment noise to
	// stderr (e.g. the localhost-proxy warning when a system proxy is set).
	assert.ok(registry.output(snapshot.id)?.stderrTail.includes("oops"));
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
	const fired: RunningEvent[] = [];
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

test("detached tasks record their real exit code from the status file", async () => {
	const registry = freshRegistry({ detachedDirPath: tempDir("det exitcode") });
	const snapshot = registry.start({ command: "exit 7", detach: true });
	assert.equal(snapshot.detached, true);
	assert.equal(snapshot.timeoutMs, 0, "detach turns the default timeout off");
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	const finished = registry.status(snapshot.id)[0];
	assert.equal(finished.status, "failed");
	assert.equal(finished.exitCode, 7, "the wrapper's printf-recorded code, not the wrapper's own 0");
	registry.dispose();
});

test("detached on_pattern fires for output written before the first poll", async () => {
	// Regression (PITFALLS P7): the file offset used to be initialized
	// lazily at the first poll tick, permanently skipping anything written
	// before it — the startup milestone, often the only early match, never
	// woke the owning session. Owned detached tasks must feed from byte 0.
	const registry = freshRegistry({ adoptPollMs: 600, detachedDirPath: tempDir("det early-pattern") });
	const events: RunningEvent[] = [];
	registry.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	const snapshot = registry.start({
		command: "echo HIT; sleep 3",
		timeoutMs: 0,
		detach: true,
		pattern: { literal: "HIT" },
	});
	await waitFor(() => events.some((event) => event.kind === "pattern"), 15_000, 20);
	assert.equal(events[0]?.line, "HIT");
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running", 15_000, 20);
	registry.dispose();
});

test("win32 detached spawns the relay through a hidden wscript launcher", { skip: process.platform !== "win32" }, () => {
	// Regression (PITFALLS P6 + P8): the wrapper travels as a host-side file
	// (never -c argv — the relay expands the double-quoted "$?" to 0), and the
	// spawn itself goes through wscript.exe: detached (DETACHED_PROCESS)
	// beats windowsHide (CREATE_NO_WINDOW) for console children, so only a
	// GUI-subsystem launcher keeps the relay popup-free.
	const dir = tempDir("det wrapper-file");
	let args: string[] | undefined;
	let opts: Record<string, unknown> | undefined;
	const fakeChild = {
		pid: 4242,
		unref: (): void => {},
		on: (): unknown => fakeChild,
	};
	const fakeSpawn = ((_cmd: string, argv: string[], options: object) => {
		args = argv;
		opts = options as Record<string, unknown>;
		return fakeChild;
	}) as unknown as typeof spawnType;
	const registry = freshRegistry({ detachedDirPath: dir, spawnFn: fakeSpawn });
	// Explicit WSL-relay spec: deterministic regardless of the host's Git Bash.
	registry.start({
		command: "exit 42",
		detach: true,
		timeoutMs: 0,
		shell: { name: "bash", bin: "C:\\Windows\\System32\\bash.exe", flavor: "wsl-bash", args: ["-c"] },
	});
	assert.ok(args !== undefined, "spawn was called");
	assert.equal(args[0], "//B");
	assert.equal(args[1], "//Nologo");
	const launcherPath = args[2] as string;
	assert.ok(/\.launcher\.vbs$/.test(launcherPath), "argv points at the launcher");
	assert.ok(!JSON.stringify(args).includes("$"), "no shell metacharacters cross argv");
	assert.equal(opts?.detached, true);
	assert.equal(opts?.stdio, "ignore");
	assert.equal(opts?.windowsHide, true);
	// The launcher starts the relay hidden and waits for it.
	const launcher = readFileSync(launcherPath, "utf8");
	const run = /shell\.Run Chr\(34\) & "C:\\Windows\\System32\\bash\.exe" & Chr\(34\) & " " & Chr\(34\) & "(.*?)" & Chr\(34\), 0, True/.exec(
		launcher,
	);
	assert.ok(run !== null, "launcher runs the resolved relay hidden and waits");
	assert.match(run[1]!, /^\/mnt\/[a-z]\//, "launcher targets the WSL wrapper path");
	// The wrapper content keeps "$?" out of the relay's argv (P6).
	const drive = /^\/mnt\/([a-z])\/(.*)$/.exec(run[1]!);
	assert.ok(drive !== null);
	const wrapperPath = `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/\//g, "\\")}`;
	const wrapper = readFileSync(wrapperPath, "utf8");
	assert.ok(wrapper.includes(`printf '%s\\n' "$?"`), "the exit-code printf survives only inside the file");
	assert.ok(wrapper.includes("( exit 42"));
	// Both artifacts are recorded for adoption-side cleanup.
	const manifestName = readdirSync(dirname(wrapperPath)).find((name) => name.endsWith(".json"));
	assert.ok(manifestName !== undefined);
	const manifest = JSON.parse(readFileSync(join(dirname(wrapperPath), manifestName), "utf8"));
	assert.equal(manifest.wrapperPath, wrapperPath);
	assert.equal(manifest.launcherPath, launcherPath);
	registry.dispose();
});

test("win32 kill routes through a hidden taskkill /t /f on the pid", { skip: process.platform !== "win32" }, () => {
	// Node's kill only terminates the direct bash.exe on Windows, orphaning
	// the WSL side; POSIX process groups do not exist there either. The kill
	// path must therefore spawn taskkill /t (tree) — itself hidden.
	const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
	const fakeChild = {
		pid: 4242,
		unref: (): void => {},
		on: (): unknown => fakeChild,
	};
	const fakeSpawn = ((cmd: string, argv: string[], options: object) => {
		calls.push({ cmd, args: argv, opts: options as Record<string, unknown> });
		return fakeChild;
	}) as unknown as typeof spawnType;
	const registry = freshRegistry({ spawnFn: fakeSpawn });
	const snapshot = registry.start({ command: "sleep 30", timeoutMs: 0 });
	registry.kill(snapshot.id, "SIGTERM");
	const killer = calls.find((call) => call.cmd === "taskkill");
	assert.ok(killer !== undefined, "taskkill spawned");
	assert.deepEqual(killer.args, ["/pid", "4242", "/t", "/f"], "tree kill, forceful");
	assert.equal(killer.opts.windowsHide, true, "the killer itself must stay hidden");
	assert.equal(killer.opts.stdio, "ignore");
	registry.dispose();
});

test("detached tasks survive dispose (quit) and are re-adopted by a fresh session", async () => {
	const shared = tempDir("det adopt");
	const first = freshRegistry({ detachedDirPath: shared, sessionId: "sess-reboot" });
	const snapshot = first.start({ command: "echo booting; sleep 2", detach: true });
	const pid = snapshot.pid;
	assert.ok(pid !== undefined);
	// Let the wrapper spawn and flush its first output before quitting: the
	// WSL relay needs ~400ms to boot, so a blind 300ms sleep races it and the
	// adoption would inspect an output file that does not exist yet.
	await waitFor(() => (first.output(snapshot.id)?.stdoutTail ?? "") !== "", 5000);
	first.dispose(); // quit: detached survivors keep running, files stay
	const second = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-reboot" });
	assert.equal(second.adoptDetached(), 1);
	const statuses = second.status();
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].status, "running");
	assert.equal(statuses[0].pid, pid);
	assert.equal(statuses[0].adopted, true);
	assert.equal(statuses[0].detached, true);
	assert.match(second.output(statuses[0].id)?.stdoutTail ?? "", /\S/, "output readable from the adopted file source");
	await waitFor(() => second.status(statuses[0].id)[0].status !== "running");
	const finished = second.status(statuses[0].id)[0];
	assert.equal(finished.status, "completed");
	assert.equal(finished.exitCode, 0);
	second.dispose();
});

test("deaths the creator already reported are never re-delivered to later scanners", async () => {
	const shared = tempDir("det reported");
	const first = freshRegistry({ detachedDirPath: shared, sessionId: "sess-r1" });
	const snapshot = first.start({ command: "exit 5", detach: true });
	await waitFor(() => first.status(snapshot.id)[0].status !== "running"); // creator watched + reported
	// Simulate a crashed session: no dispose, the manifest stays on disk.
	const second = freshRegistry({ detachedDirPath: shared, sessionId: "sess-r2" });
	const wakes: number[] = [];
	second.onExit = (finished) => wakes.push(finished.id);
	assert.equal(second.adoptDetached(), 0, "terminal tasks never count as alive adoption");
	const statuses = second.status();
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0].status, "failed");
	assert.equal(statuses[0].exitCode, 5);
	assert.deepEqual(wakes, [], "already-reported deaths stay quiet (ADR-0007 .reported)");
	second.dispose();
});

test("deaths while pi was away are backfilled once, annotated as unattended", async () => {
	const shared = tempDir("det backfill");
	const first = freshRegistry({ detachedDirPath: shared, sessionId: "sess-b1" });
	const snapshot = first.start({ command: "echo go; sleep 0.4; exit 5", detach: true });
	await waitFor(() => (first.output(snapshot.id)?.stdoutTail ?? "") !== "", 5000);
	first.dispose(); // quit BEFORE the task exits: nobody watches it die
	await waitFor(() => {
		for (const dir of readdirSync(shared)) {
			for (const name of readdirSync(join(shared, dir))) {
				if (!name.endsWith(".exit")) continue;
				try {
					if (readFileSync(join(shared, dir, name), "utf8").trim() !== "") return true;
				} catch {
					// raced the wrapper's write; retry
				}
			}
		}
		return false;
	});
	const second = freshRegistry({ detachedDirPath: shared, sessionId: "sess-b2" });
	const wakes: TaskSnapshot[] = [];
	second.onExit = (finished) => wakes.push(finished);
	assert.equal(second.adoptDetached(), 0);
	assert.equal(wakes.length, 1, "unreported deaths backfill exactly once (ADR-0007)");
	assert.equal(wakes[0].unattended, true, "annotated as unattended");
	assert.equal(wakes[0].exitCode, 5);
	assert.equal(second.status()[0].status, "failed");
	// Idempotence: a third scanner delivers nothing.
	const third = freshRegistry({ detachedDirPath: shared, sessionId: "sess-b3" });
	const wakes3: number[] = [];
	third.onExit = (finished) => wakes3.push(finished.id);
	third.adoptDetached();
	assert.deepEqual(wakes3, [], ".reported makes the backfill single-shot");
	assert.equal(third.status()[0].status, "failed", "still queryable");
	second.dispose();
	third.dispose();
});

test("killing a detached task terminates the whole relay tree on Windows (group on POSIX)", async () => {
	const registry = freshRegistry({ detachedDirPath: tempDir("det kill") });
	const snapshot = registry.start({ command: "sleep 30", detach: true });
	registry.kill(snapshot.id, "SIGTERM");
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running", 15_000, 20);
	assert.equal(registry.status(snapshot.id)[0].status, "killed");
	registry.dispose();
});

test("detached tasks ignore the default timeout", async () => {
	const registry = freshRegistry({ defaultTimeoutMs: 150, detachedDirPath: tempDir("det timeout") });
	const snapshot = registry.start({ command: "sleep 1", detach: true });
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.equal(registry.status(snapshot.id)[0].status, "running", "default timeout must not kill detached tasks");
	await waitFor(() => registry.status(snapshot.id)[0].status !== "running");
	assert.equal(registry.status(snapshot.id)[0].status, "completed");
	registry.dispose();
});

test("adopted detached tasks keep pattern watching alive", async () => {
	// The first session's poll is parked (60 s) so it cannot consume the match.
	const shared = tempDir("det live-pattern");
	const first = freshRegistry({ adoptPollMs: 60_000, detachedDirPath: shared, sessionId: "sess-p1" });
	first.start({ command: "sleep 0.4; echo HIT; sleep 2", detach: true, pattern: { literal: "HIT" } });
	const second = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-p1" });
	const events: RunningEvent[] = [];
	second.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	assert.equal(second.adoptDetached(), 1);
	await waitFor(() => events.some((event) => event.kind === "pattern"));
	assert.equal(events[0]?.line, "HIT");
	const id = second.status()[0].id;
	second.kill(id, "SIGKILL");
	await waitFor(() => second.status(id)[0].status !== "running");
	first.dispose();
	second.dispose();
});

test("a pattern that fired while nobody watched is delivered once on adoption", async () => {
	// First session crashes before the match; its 60 s poll never persists fired.
	const shared = tempDir("det stale-pattern");
	const first = freshRegistry({ adoptPollMs: 60_000, detachedDirPath: shared, sessionId: "sess-s1" });
	first.start({ command: "sleep 0.3; echo ROOTED; sleep 2", detach: true, pattern: { literal: "ROOTED" } });
	await new Promise((resolve) => setTimeout(resolve, 800)); // ROOTED is now in the log file
	const second = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-s1" });
	const events: RunningEvent[] = [];
	second.onRunningEvent = (_snapshot, _output, event) => events.push(event);
	assert.equal(second.adoptDetached(), 1);
	await waitFor(() => events.some((event) => event.kind === "pattern"));
	assert.equal(events.filter((event) => event.kind === "pattern").length, 1, "exactly one stale delivery");
	assert.equal(events[0]?.line, "ROOTED");
	assert.equal(second.status()[0].pattern?.matches, 1);
	const id = second.status()[0].id;
	second.kill(id, "SIGKILL");
	await waitFor(() => second.status(id)[0].status !== "running");
	first.dispose();
	second.dispose();
});

test("every spawn we own hides its console on Windows (relay never pops a window)", () => {
	let opts: Record<string, unknown> | undefined;
	const fakeChild = {
		pid: 4242,
		unref: (): void => {},
		on: (): unknown => fakeChild,
	};
	const fakeSpawn = ((_cmd: string, _argv: string[], options: object) => {
		opts = options as Record<string, unknown>;
		return fakeChild;
	}) as unknown as typeof spawnType;
	const registry = freshRegistry({ spawnFn: fakeSpawn });
	registry.start({ command: "true", timeoutMs: 0 });
	assert.equal(opts?.windowsHide, true, "non-detached spawns must be hidden too");
	registry.dispose();
});

test("manifests owned by a live foreign process are not adopted", async () => {
	// Pool isolation (ADR-0006): a live foreign owner's manifest is invisible —
	// not adopted, not reaped, not listed. The "foreign pi process" here is any
	// pid that is alive and not ours.
	const shared = tempDir("det foreign-owner");
	const registry = freshRegistry({ detachedDirPath: shared });
	const holder = registry.start({ command: "sleep 30", timeoutMs: 0 });
	await waitFor(() => registry.status(holder.id)[0].status === "running");
	const dir = join(shared, "s-forged");
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "forged.json");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			version: 1,
			pid: holder.pid,
			command: "sleep 30",
			label: "foreign",
			cwd: process.cwd(),
			startedAt: Date.now(),
			hostname: hostname(),
			stdoutPath: join(dir, "o.log"),
			stderrPath: join(dir, "e.log"),
			statusPath: join(dir, ".exit"),
			ownerPid: holder.pid,
		}),
	);
	assert.equal(registry.adoptDetached(), 0, "live foreign owner — pool stays private");
	assert.equal(
		registry.status().filter((task) => task.adopted).length,
		0,
		"nothing from the foreign pool is listed",
	);
	assert.ok(existsSync(manifestPath), "the foreign manifest is left untouched");
	assert.equal(registry.listForeign().length, 1, "foreign pool tasks are visible (ADR-0007)");
	assert.equal(registry.listForeign()[0].label, "foreign");
	registry.kill(holder.id, "SIGKILL");
	await waitFor(() => registry.status(holder.id)[0].status !== "running");
	registry.dispose();
});

test("legacy running manifests are foreign: visible, adoptable, never re-owned", async () => {
	// Pre-subscription artifacts (started before the upgrade) carry no
	// sessionId: they never auto-subscribe (ADR-0007) but stay visible in the
	// pool and adoptable via adoptByPath — without an ownership rewrite.
	const shared = tempDir("det legacy-foreign");
	const registry = freshRegistry({ detachedDirPath: shared, sessionId: "sess-lg" });
	const holder = registry.start({ command: "sleep 30", timeoutMs: 0 });
	await waitFor(() => registry.status(holder.id)[0].status === "running");
	const dir = join(shared, "s-legacy");
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "legacy.json");
	writeFileSync(join(dir, "o.log"), "");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			version: 1,
			pid: holder.pid,
			command: "sleep 30",
			label: "legacy",
			cwd: process.cwd(),
			startedAt: Date.now(),
			hostname: hostname(),
			stdoutPath: join(dir, "o.log"),
			stderrPath: join(dir, "e.log"),
			statusPath: join(dir, ".exit"),
		}),
	);
	assert.equal(registry.adoptDetached(), 0, "no sessionId — foreign, never auto-subscribed");
	const foreign = registry.listForeign();
	assert.equal(foreign.length, 1);
	assert.equal(foreign[0].label, "legacy");
	assert.equal(foreign[0].manifestPath, manifestPath);
	const adopted = registry.adoptByPath(manifestPath);
	assert.equal(adopted.adopted, true);
	assert.equal(adopted.status, "running");
	assert.ok(existsSync(join(dir, `legacy.sub.${process.pid}`)), "subscription marker written (wx)");
	const after = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(after.ownerPid, undefined, "adoption never rewrites ownership (ADR-0007)");
	assert.equal(registry.listForeign().length, 0, "adopted — no longer foreign");
	registry.kill(holder.id, "SIGKILL");
	await waitFor(() => registry.status(holder.id)[0].status !== "running");
	registry.dispose();
});

test("same-session survivors re-subscribe automatically; strangers must adopt explicitly", async () => {
	const shared = tempDir("det session-scope");
	const first = freshRegistry({ detachedDirPath: shared, sessionId: "sess-alpha" });
	const snapshot = first.start({ command: "echo hi; sleep 5", detach: true });
	await waitFor(() => (first.output(snapshot.id)?.stdoutTail ?? "") !== "", 5000);
	first.dispose();
	// Resumed conversation (pi -c / --resume / --session): same id → automatic.
	const twin = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-alpha" });
	assert.equal(twin.adoptDetached(), 1, "same sessionId re-subscribes");
	assert.equal(twin.status()[0].adopted, true);
	twin.dispose();
	// A different conversation: visible, manual adoption only (ADR-0007).
	const stranger = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-beta" });
	assert.equal(stranger.adoptDetached(), 0, "foreign session never auto-subscribes");
	const foreign = stranger.listForeign();
	assert.equal(foreign.length, 1);
	assert.equal(foreign[0].sessionId, "sess-alpha");
	const adopted = stranger.adoptByPath(foreign[0].manifestPath);
	assert.equal(adopted.status, "running");
	stranger.kill(adopted.id, "SIGKILL");
	await waitFor(() => stranger.status(adopted.id)[0].status !== "running", 15_000, 20);
	stranger.dispose();
});

test("two subscribing sessions each receive the live pattern wake", async () => {
	const shared = tempDir("det multi-sub");
	const creator = freshRegistry({ adoptPollMs: 60_000, detachedDirPath: shared, sessionId: "sess-m0" });
	creator.start({ command: "sleep 0.8; echo HIT; sleep 2", detach: true, pattern: { literal: "HIT" } });
	const a = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-ma" });
	const b = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-mb" });
	const eventsA: RunningEvent[] = [];
	const eventsB: RunningEvent[] = [];
	a.onRunningEvent = (_snapshot, _output, event) => eventsA.push(event);
	b.onRunningEvent = (_snapshot, _output, event) => eventsB.push(event);
	// Subscribe both BEFORE the marker is written: the live match must fan out
	// to every subscriber. (The stale replay is once per task — a later
	// subscriber only recovers the count, per ADR-0006/0007 semantics.)
	const listing = a.listForeign();
	assert.equal(listing.length, 1);
	a.adoptByPath(listing[0].manifestPath);
	b.adoptByPath(listing[0].manifestPath);
	await waitFor(() => eventsA.some((event) => event.kind === "pattern"), 15_000, 20);
	await waitFor(() => eventsB.some((event) => event.kind === "pattern"), 15_000, 20);
	assert.equal(eventsA[0]?.line, "HIT");
	assert.equal(eventsB[0]?.line, "HIT");
	a.kill(a.status()[0].id, "SIGKILL");
	await waitFor(() => a.status()[0].status !== "running", 15_000, 20);
	creator.dispose();
	a.dispose();
	b.dispose();
});

test("a pool kill is attributed to the killer in other subscribers' notices", async () => {
	const shared = tempDir("det killby");
	const creator = freshRegistry({ detachedDirPath: shared, sessionId: "sess-kc" });
	creator.start({ command: "sleep 30", detach: true });
	const watcher = freshRegistry({ adoptPollMs: 50, detachedDirPath: shared, sessionId: "sess-kw" });
	const wakes: TaskSnapshot[] = [];
	watcher.onExit = (finished) => wakes.push(finished);
	const manifestPath = watcher.listForeign()[0].manifestPath;
	watcher.adoptByPath(manifestPath);
	creator.kill(creator.status()[0].id, "SIGKILL");
	await waitFor(() => wakes.length === 1, 15_000, 20);
	assert.equal(wakes[0].killedBy, "sess-kc", "foreign kill attributed cross-session (ADR-0007)");
	creator.dispose();
	watcher.dispose();
});

test("finished pool entries are collected once reported, unsubscribed, and creator gone", async () => {
	const shared = tempDir("det collect");
	const dead = spawnSync(process.execPath, ["-e", ""]); // a genuinely dead pid
	const dir = join(shared, "s-old");
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "old.json");
	const writeCase = (reported: boolean) => {
		writeFileSync(join(dir, "o.log"), "out");
		writeFileSync(join(dir, "e.log"), "");
		writeFileSync(join(dir, ".exit"), "0");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 1,
				pid: dead.pid,
				command: "true",
				label: "old",
				cwd: process.cwd(),
				startedAt: Date.now() - 1000,
				hostname: hostname(),
				stdoutPath: join(dir, "o.log"),
				stderrPath: join(dir, "e.log"),
				statusPath: join(dir, ".exit"),
				ownerPid: dead.pid,
			}),
		);
		if (reported) writeFileSync(join(dir, "old.reported"), "");
	};
	// Unreported: registered + backfilled, artifacts stay for the reporter.
	writeCase(false);
	const first = freshRegistry({ detachedDirPath: shared, sessionId: "sess-c1" });
	const wakes: number[] = [];
	first.onExit = (finished) => wakes.push(finished.id);
	first.adoptDetached();
	assert.equal(wakes.length, 1, "unreported death backfills once");
	assert.ok(existsSync(join(dir, "o.log")), "artifacts stay for the reporting session");
	first.dispose();
	// Next scanner: reported + no live subscribers + creator gone → collected.
	const second = freshRegistry({ detachedDirPath: shared, sessionId: "sess-c2" });
	second.adoptDetached();
	assert.ok(!existsSync(manifestPath), "manifest collected");
	assert.ok(!existsSync(join(dir, "o.log")), "output collected");
	assert.ok(!existsSync(join(dir, ".exit")), "status collected");
	assert.ok(!existsSync(join(dir, "old.reported")), "marker collected");
	second.dispose();
});

test("toWslPath translates Windows drive paths and rejects the rest", () => {
	assert.equal(toWslPath("C:\\Users\\a\\b.log"), "/mnt/c/Users/a/b.log");
	assert.equal(toWslPath("d:/x/y z"), "/mnt/d/x/y z");
	assert.equal(toWslPath("\\\\server\\\\share\\\\x"), undefined, "UNC shares are untranslatable");
	assert.equal(toWslPath("/tmp/x"), undefined, "POSIX paths are not Windows paths");
	assert.equal(toWslPath("C:"), undefined, "drive without a path part");
});

test("buildWslDetachedWrapper shell-redirects all three artifacts", () => {
	const wrapped = buildWslDetachedWrapper("echo hi", {
		stdoutPath: "/mnt/c/t/o.log",
		stderrPath: "/mnt/c/t/e.log",
		statusPath: "/mnt/c/t/.exit",
	});
	assert.equal(
		wrapped,
		"( echo hi\n) >> '/mnt/c/t/o.log' 2>> '/mnt/c/t/e.log'\nprintf '%s\\n' \"$?\" > '/mnt/c/t/.exit'",
	);
});

test("buildWslDetachedWrapper single-quotes hostile path characters", () => {
	const wrapped = buildWslDetachedWrapper("true", {
		stdoutPath: "/mnt/c/a'b",
		stderrPath: "/mnt/c/e",
		statusPath: "/mnt/c/s",
	});
	assert.ok(wrapped.includes("'/mnt/c/a'\\''b'"), "embedded quote is escaped posix-style");
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

test("windows-bash detached writes a forward-slash wrapper and a full-bin launcher", () => {
	// ADR-0009: Git Bash/Cygwin/MSYS2 address C:/ paths directly — the wrapper
	// keeps bash syntax but needs no /mnt translation, and the launcher embeds
	// the resolved interpreter (it may not be on PATH).
	const dir = tempDir("det winbash");
	let args: string[] | undefined;
	const fakeChild = { pid: 4242, unref: (): void => {}, on: (): unknown => fakeChild };
	const fakeSpawn = ((_cmd: string, argv: string[]) => {
		args = argv;
		return fakeChild;
	}) as unknown as typeof spawnType;
	const registry = freshRegistry({ detachedDirPath: dir, spawnFn: fakeSpawn });
	const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
	const snapshot = registry.start({
		command: "exit 5",
		detach: true,
		timeoutMs: 0,
		shell: { name: "bash", bin: gitBash, flavor: "windows-bash", args: ["-c"] },
	});
	assert.equal(snapshot.shell, "bash");
	assert.ok(args !== undefined && /\.launcher\.vbs$/.test(args[2] as string));
	const launcherPath = args![2]!;
	const launcher = readFileSync(launcherPath, "utf8");
	const run = new RegExp(
		`shell\\.Run Chr\\(34\\) & "${gitBash.replace(/\\/g, "\\\\")}" & Chr\\(34\\) & " " & Chr\\(34\\) & "(.*?)" & Chr\\(34\\), 0, True`,
	).exec(launcher);
	assert.ok(run !== null, "launcher runs the resolved Git Bash hidden and waits");
	const wrapperPath = run[1]!;
	assert.ok(!wrapperPath.startsWith("/mnt/"), "no WSL translation for native Windows bash");
	const wrapper = readFileSync(wrapperPath, "utf8");
	assert.ok(wrapper.includes(`printf '%s\\n' "$?"`), "exit code recorded inside the file (P6 shape)");
	assert.ok(/>> '.*stdout\.log'/.test(wrapper), "redirects use forward-slash Windows paths");
	const manifestName = readdirSync(dirname(wrapperPath)).find((name) => name.endsWith(".json"));
	const manifest = JSON.parse(readFileSync(join(dirname(wrapperPath), manifestName!), "utf8"));
	assert.equal(manifest.shell, "bash");
	registry.dispose();
});

test("powershell detached rides PI_BG_SHELL_CMD through a cmd wrapper", () => {
	// ADR-0009: the command travels as an env var — the wrapper is a fully
	// static template (no quoting anywhere on the wscript → cmd → pwsh chain),
	// and cmd's raw-byte 1>>/2>> bypass PowerShell 5.1's UTF-16LE >>.
	const dir = tempDir("det pwsh");
	let spawnOptions: Record<string, unknown> | undefined;
	let args: string[] | undefined;
	const fakeChild = { pid: 4242, unref: (): void => {}, on: (): unknown => fakeChild };
	const fakeSpawn = ((_cmd: string, argv: string[], options: object) => {
		args = argv;
		spawnOptions = options as Record<string, unknown>;
		return fakeChild;
	}) as unknown as typeof spawnType;
	const registry = freshRegistry({ detachedDirPath: dir, spawnFn: fakeSpawn });
	const pwshBin = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
	const snapshot = registry.start({
		command: "Write-Output secret-payload",
		detach: true,
		timeoutMs: 0,
		shell: { name: "pwsh", bin: pwshBin, flavor: "powershell", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] },
	});
	assert.equal(snapshot.shell, "pwsh");
	assert.ok(args !== undefined && /\.launcher\.vbs$/.test(args[2] as string));
	const launcher = readFileSync(args![2]!, "utf8");
	assert.match(launcher, /shell\.Run Chr\(34\) & ".*cmd\.exe" & Chr\(34\) & " \/c " & Chr\(34\)/, "launcher goes through cmd /c");
	// Detached artifacts live in a per-session mkdtemp dir under the root.
	const sessionDir = join(dir, readdirSync(dir)[0]!);
	const wrapperPath = readdirSync(sessionDir).find((name) => name.endsWith(".wrapper.cmd"));
	assert.ok(wrapperPath !== undefined, "pwsh detached wrapper is a .cmd file");
	const wrapper = readFileSync(join(sessionDir, wrapperPath!), "utf8");
	assert.ok(wrapper.startsWith("@echo off\r\n"), "CRLF batch file");
	assert.ok(wrapper.includes('"Invoke-Expression $env:PI_BG_SHELL_CMD"'), "fixed inner invocation");
	assert.ok(wrapper.includes("1>>\"") && wrapper.includes("2>>\""), "raw byte redirects");
	assert.ok(wrapper.includes("(echo %ERRORLEVEL%)>\""), "status write survives cmd expansion rules");
	assert.ok(!wrapper.includes("secret-payload"), "the command itself never lands in the wrapper");
	const env = spawnOptions?.env as Record<string, string>;
	assert.ok(env?.PI_BG_SHELL_CMD.includes("secret-payload"), "the command rides the env var");
	assert.ok(env?.PI_BG_SHELL_CMD.includes("& { Write-Output secret-payload"));
	assert.ok(env?.PI_BG_SHELL_CMD.includes("elseif (Test-Path variable:LASTEXITCODE)"), "exit-code trailer attached");
	const manifestName = readdirSync(sessionDir).find((name) => name.endsWith(".json"));
	const manifest = JSON.parse(readFileSync(join(sessionDir, manifestName!), "utf8"));
	assert.equal(manifest.shell, "pwsh");
	registry.dispose();
});

test("powershell normal tasks spawn with the native argv and UTF-8 prefix", () => {
	const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
	const fakeChild = { pid: 4242, unref: (): void => {}, on: (): unknown => fakeChild };
	const fakeSpawn = ((cmd: string, argv: string[], options: object) => {
		calls.push({ cmd, args: argv, opts: options as Record<string, unknown> });
		return fakeChild;
	}) as unknown as typeof spawnType;
	const registry = freshRegistry({ spawnFn: fakeSpawn });
	registry.start({
		command: "Write-Output hi",
		timeoutMs: 0,
		shell: { name: "pwsh", bin: "pwsh.exe", flavor: "powershell", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] },
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, "pwsh.exe");
	assert.deepEqual(calls[0].args, [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nWrite-Output hi",
	]);
	assert.equal(calls[0].opts.windowsHide, true);
	registry.dispose();
});
