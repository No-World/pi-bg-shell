/**
 * Completion notifier — turns task exits into agent wake-ups.
 *
 * Uses pi.sendMessage() with { triggerTurn: true } (the same primitive the
 * pi-subagents completion path and the official file-trigger example rely
 * on): idle sessions start a new agent turn, busy sessions get the message
 * queued. Exits inside a short debounce window merge into one message so a
 * fan-out of tasks cannot stampede the session (ADR-0003).
 */

import type { RunningEvent, TaskOutput, TaskSnapshot } from "./tasks.ts";

export interface NotifyMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

export interface NotifyOptions {
	triggerTurn?: boolean;
}

export type SendMessageFn = (message: NotifyMessage, options?: NotifyOptions) => Promise<void> | void;

export interface CompletionNotifierOptions {
	sendMessage: SendMessageFn;
	/** Merge window for batch completions. Default 100 ms. */
	debounceMs?: number;
	/** Hard cap for message content. Default 6000 chars. */
	maxContentChars?: number;
	/** Per-task output tail budget inside a message. Default 3500 chars. */
	maxTaskOutputChars?: number;
	/** Retry delay when sendMessage throws. Default 2000 ms. */
	retryDelayMs?: number;
}

const STATUS_VERB: Record<TaskSnapshot["status"], string> = {
	running: "is still running",
	completed: "completed",
	failed: "failed",
	killed: "was killed",
	timeout: "timed out",
};

interface FinishedTask {
	snapshot: TaskSnapshot;
	output: TaskOutput;
}

/** One queued running-task event (ADR-0005). */
export interface QueueEntry {
	snapshot: TaskSnapshot;
	output: TaskOutput;
	event: RunningEvent;
}

type PendingItem = { kind: "exit"; task: FinishedTask } | { kind: "running"; item: QueueEntry };

/** Anything formattable: an exit, or a running event with its payload. */
type DeliveryEntry = { snapshot: TaskSnapshot; output: TaskOutput; event: RunningEvent | undefined };

export class CompletionNotifier {
	private pending: PendingItem[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly options: CompletionNotifierOptions;

	constructor(options: CompletionNotifierOptions) {
		this.options = options;
	}

	private get debounceMs(): number {
		return this.options.debounceMs ?? 100;
	}

	private get maxContentChars(): number {
		return this.options.maxContentChars ?? 6000;
	}

	private get maxTaskOutputChars(): number {
		return this.options.maxTaskOutputChars ?? 3500;
	}

	private get retryDelayMs(): number {
		return this.options.retryDelayMs ?? 2000;
	}

	/** Queue one finished task; flushes after the debounce window. */
	push(snapshot: TaskSnapshot, output: TaskOutput): void {
		if (snapshot.status === "running") return;
		this.pending.push({ kind: "exit", task: { snapshot, output } });
		this.scheduleFlush();
	}

	/** Queue one running-task event (pattern match / progress report). */
	pushEvent(snapshot: TaskSnapshot, output: TaskOutput, event: RunningEvent): void {
		if (snapshot.status !== "running") return;
		this.pending.push({ kind: "running", item: { snapshot, output, event } });
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.timer === undefined) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, this.debounceMs);
		}
	}

	/** Flush immediately (used at session quit before the runtime goes away). */
	flushNow(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.pending.length > 0) void this.flush();
	}

	private async flush(): Promise<void> {
		const batch = this.pending;
		this.pending = [];
		if (batch.length === 0) return;
		const entries: DeliveryEntry[] = batch.map((item) =>
			item.kind === "exit"
				? { snapshot: item.task.snapshot, output: item.task.output, event: undefined }
				: { snapshot: item.item.snapshot, output: item.item.output, event: item.item.event },
		);
		const raw = entries.length === 1 ? this.formatSingle(entries[0]) : this.formatGrouped(entries);
		// The follow-up hint is appended after truncation so it always survives —
		// it is the strongest in-context steer toward bg_status/bg_kill.
		const content =
			`${this.truncateForModel(raw)}\n(bg_status {"id": ${entries[0].snapshot.id}} fetches more output; bg_status lists all tasks; bg_kill {"id": N} stops one)`;
		try {
			await this.options.sendMessage(
				{ customType: "bg-shell-notify", content, display: true, details: undefined },
				{ triggerTurn: true },
			);
		} catch {
			// One bounded retry: a session busy switching states can reject a
			// message; dropping the output silently would strand the agent.
			this.retryTimer = setTimeout(() => {
				this.retryTimer = undefined;
				void Promise.resolve(
					this.options.sendMessage(
						{ customType: "bg-shell-notify", content, display: true, details: undefined },
						{ triggerTurn: true },
					),
				).catch(() => undefined);
			}, this.retryDelayMs);
		}
	}

	formatSingle(entry: DeliveryEntry): string {
		if (entry.event !== undefined) {
			return `${this.eventHeader(entry)}\n${this.eventBody(entry)}${this.taskOutput(entry)}`;
		}
		return `${this.headerLine(entry.snapshot)}\n${this.taskOutput(entry)}`;
	}

	formatGrouped(entries: DeliveryEntry[]): string {
		const exits = entries.filter((entry) => entry.event === undefined);
		const lead =
			exits.length === entries.length
				? `${entries.length} background tasks finished:`
				: `${entries.length} background task events:`;
		const lines = entries.map((entry) => `- ${entry.event !== undefined ? this.eventHeader(entry) : this.headerLine(entry.snapshot)}`);
		const bodies = entries.map(
			(entry) => `=== ${entry.event !== undefined ? this.eventHeader(entry) : this.headerLine(entry.snapshot)} ===\n${entry.event !== undefined ? this.eventBody(entry) : ""}${this.taskOutput(entry)}`,
		);
		return `${lead}\n${lines.join("\n")}\n\n${bodies.join("\n")}`;
	}

	private headerLine(task: TaskSnapshot): string {
		const exit = task.exitCode !== null ? `exit ${task.exitCode}` : task.signal ? `signal ${task.signal}` : "no exit";
		const duration = task.durationMs !== undefined ? `${(task.durationMs / 1000).toFixed(1)}s` : "?";
		const pattern = task.pattern !== undefined && task.pattern.matches > 0 ? `, on_pattern ×${task.pattern.matches}` : "";
		const unattended = task.unattended ? ", unattended — finished while pi was away" : "";
		const killedBy = task.killedBy !== undefined ? `, killed by ${task.killedBy}` : "";
		return `Background task #${task.id} ${STATUS_VERB[task.status]} (${exit}, ${duration}${pattern}${unattended}${killedBy}): ${task.label}`;
	}

	private eventHeader(entry: DeliveryEntry): string {
		const task = entry.snapshot;
		const event = entry.event;
		if (event === undefined) return this.headerLine(task);
		const elapsed = `${Math.max(0, (Date.now() - task.startedAt) / 1000).toFixed(1)}s`;
		if (event.kind === "pattern") {
			const count = event.matches !== undefined ? `, match #${event.matches}` : "";
			return `Background task #${task.id} pattern match (on_pattern "${task.pattern?.literal ?? ""}"${count}, running ${elapsed}): ${task.label}`;
		}
		const every = task.reportEveryMs !== undefined ? `, report every ${Math.round(task.reportEveryMs / 1000)}s` : "";
		return `Background task #${task.id} still running (${elapsed} elapsed${every}): ${task.label}`;
	}

	private eventBody(entry: DeliveryEntry): string {
		const event = entry.event;
		if (event?.kind === "pattern") {
			const line = event.line ?? "";
			return `--- matched line (${event.stream ?? "stdout"}) ---\n${line.slice(0, 400)}\n`;
		}
		return "";
	}

	private taskOutput(task: { snapshot: TaskSnapshot; output: TaskOutput }): string {
		const budget = this.maxTaskOutputChars;
		const stdout = this.streamSection(
			"stdout",
			task.output.stdoutTail,
			task.output.stdoutBytes,
			task.output.stdoutTruncated,
			task.output.stdoutSpillPath,
			Math.floor(budget * 0.7),
		);
		const stderr = this.streamSection(
			"stderr",
			task.output.stderrTail,
			task.output.stderrBytes,
			task.output.stderrTruncated,
			task.output.stderrSpillPath,
			Math.floor(budget * 0.3),
		);
		if (task.snapshot.errorMessage !== undefined && task.output.stderrTail === "") {
			return `${stdout}${stderr}--- error ---\n${task.snapshot.errorMessage}\n`;
		}
		return `${stdout}${stderr}`;
	}

	private streamSection(
		name: string,
		tail: string,
		totalBytes: number,
		truncated: boolean,
		spillPath: string | undefined,
		charBudget: number,
	): string {
		if (totalBytes === 0 && tail === "") return `--- ${name} (empty) ---\n`;
		let shown = tail;
		let note = `${shown.length}/${totalBytes} bytes`;
		if (shown.length > charBudget) {
			shown = shown.slice(shown.length - charBudget);
			note = `last ${shown.length}/${totalBytes} bytes`;
		}
		const spill = truncated && spillPath
			? `; full output: ${spillPath}`
			: truncated
				? "; full output lost (spill unavailable)"
				: "";
		return `--- ${name} tail (${note}${spill}) ---\n${shown}\n`;
	}

	/** Trim the final content to the hard cap, keeping the head (headers). */
	truncateForModel(content: string): string {
		if (content.length <= this.maxContentChars) return content;
		const head = content.slice(0, Math.floor(this.maxContentChars * 0.8));
		return `${head}\n…content truncated (${content.length} chars total; use bg_status for the rest)\n`;
	}
}
