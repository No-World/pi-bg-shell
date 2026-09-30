import assert from "node:assert/strict";
import test from "node:test";
import { CompletionNotifier, type NotifyMessage, type NotifyOptions, type SendMessageFn } from "../extensions/bg-shell/notify.ts";
import type { TaskOutput, TaskSnapshot } from "../extensions/bg-shell/tasks.ts";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: 7,
		label: "npm test",
		command: "npm test",
		cwd: "/repo",
		pid: 4242,
		status: "completed",
		exitCode: 0,
		signal: null,
		errorMessage: undefined,
		startedAt: 1000,
		finishedAt: 43000,
		durationMs: 42000,
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

function output(overrides: Partial<TaskOutput> = {}): TaskOutput {
	return {
		stdoutTail: "all tests passed",
		stderrTail: "",
		stdoutBytes: 17,
		stderrBytes: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
		stdoutSpillPath: undefined,
		stderrSpillPath: undefined,
		...overrides,
	};
}

interface Captured {
	messages: NotifyMessage[];
	optionsList: (NotifyOptions | undefined)[];
}

function capturingSend(captured: Captured, failTimes = 0): SendMessageFn {
	let calls = 0;
	return (message, options) => {
		calls += 1;
		if (calls <= failTimes) throw new Error("send rejected");
		captured.messages.push(message);
		captured.optionsList.push(options);
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a single completion sends one message with triggerTurn", async () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({ sendMessage: capturingSend(captured), debounceMs: 10, retryDelayMs: 10 });
	notifier.push(snapshot(), output());
	await sleep(60);
	assert.equal(captured.messages.length, 1);
	const message = captured.messages[0];
	assert.equal(message.customType, "bg-shell-notify");
	assert.equal(message.display, true);
	assert.match(message.content, /#7 completed \(exit 0, 42\.0s\): npm test/);
	assert.match(message.content, /all tests passed/);
	assert.deepEqual(captured.optionsList[0], { triggerTurn: true });
});

test("running snapshots are ignored", async () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({ sendMessage: capturingSend(captured), debounceMs: 10 });
	notifier.push(snapshot({ status: "running" }), output());
	await sleep(40);
	assert.equal(captured.messages.length, 0);
});

test("completions inside the debounce window merge into one grouped message", async () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({ sendMessage: capturingSend(captured), debounceMs: 30 });
	notifier.push(snapshot({ id: 1, label: "build", status: "failed", exitCode: 2 }), output({ stdoutTail: "" }));
	notifier.push(snapshot({ id: 2, label: "watch", status: "killed", exitCode: null, signal: "SIGTERM" }), output());
	await sleep(80);
	assert.equal(captured.messages.length, 1);
	const content = captured.messages[0].content;
	assert.match(content, /2 background tasks finished:/);
	assert.match(content, /#1 failed \(exit 2/);
	assert.match(content, /#2 was killed \(signal SIGTERM/);
});

test("a rejected send is retried once and then succeeds", async () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({
		sendMessage: capturingSend(captured, 1),
		debounceMs: 5,
		retryDelayMs: 20,
	});
	notifier.push(snapshot(), output());
	await sleep(10);
	assert.equal(captured.messages.length, 0, "first attempt threw, nothing captured yet");
	await sleep(60);
	assert.equal(captured.messages.length, 1, "retry delivered the message");
});

test("spill paths are surfaced when output was truncated", async () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({ sendMessage: capturingSend(captured), debounceMs: 5 });
	notifier.push(
		snapshot({ status: "completed", stdoutTruncated: true, stdoutSpillPath: "/tmp/x.log" }),
		output({ stdoutTruncated: true, stdoutSpillPath: "/tmp/x.log" }),
	);
	await sleep(40);
	assert.match(captured.messages[0].content, /full output: \/tmp\/x\.log/);
});

test("formatGrouped and single formatting share the header contract", () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({ sendMessage: capturingSend(captured), debounceMs: 5 });
	const single = notifier.formatSingle({ snapshot: snapshot(), output: output() });
	assert.match(single, /^Background task #7 completed/);
	const grouped = notifier.formatGrouped([
		{ snapshot: snapshot({ id: 1 }), output: output() },
		{ snapshot: snapshot({ id: 2 }), output: output() },
	]);
	assert.match(grouped, /=== Background task #1 completed/);
	assert.match(grouped, /=== Background task #2 completed/);
});

test("truncateForModel keeps the head and appends a pointer to bg_status", () => {
	const captured: Captured = { messages: [], optionsList: [] };
	const notifier = new CompletionNotifier({ sendMessage: capturingSend(captured), debounceMs: 5, maxContentChars: 100 });
	const truncated = notifier.truncateForModel("a".repeat(500));
	assert.ok(truncated.length < 200);
	assert.match(truncated, /use bg_status for the rest/);
});
