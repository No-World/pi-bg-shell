/**
 * Shell selection for bg-shell, aligned with pi's native tools (ADR-0009).
 *
 * `bash_bg` resolves bash exactly like the native `bash` tool (shellPath
 * setting → Git Bash → PATH), and `powershell_bg` mirrors the optional
 * native `powershell` tool (pwsh.exe first, then Windows PowerShell, same
 * argv prefix). The agent picks a shell by picking the tool — there is no
 * per-call parameter, matching how native works and keeping one mental
 * model across foreground and background execution.
 *
 * The resolved `ShellSpec` also classifies the bash flavor for the detached
 * machinery: the WSL relay needs /mnt path translation and a .sh wrapper,
 * while a native Windows bash (Git Bash/Cygwin/MSYS2) addresses C:/ paths
 * directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** How the spawn/detach machinery must treat a shell. */
export type ShellFlavor =
	| "posix-bash"
	| "wsl-bash"
	| "windows-bash"
	| "powershell";

/** Everything the registry needs to run commands through one interpreter. */
export interface ShellSpec {
	/** Display name on snapshots/manifests: "bash" | "pwsh". */
	name: "bash" | "pwsh";
	/** Executable to spawn. */
	bin: string;
	flavor: ShellFlavor;
	/** Fixed argv before the command; the command is the final argv element. */
	args: string[];
}

/** The slice of pi settings that steers shell resolution (native parity). */
export interface ShellSettings {
	shellPath?: string;
}

/** Injectable fs/path probing so resolution is unit-testable (ADR-0009). */
export interface ShellIo {
	exists(path: string): boolean;
	/** First `where`/`which` hit that exists, mirroring native's lookup. */
	which(executable: string): string | undefined;
}

const realIo: ShellIo = {
	exists: (path) => existsSync(path),
	which: (executable) => {
		// Native probes `where` on win32 (falls through to `which` elsewhere);
		// both print one candidate per line and we take the first that exists.
		for (const probe of process.platform === "win32" ? ["where", "which"] : ["which"]) {
			try {
				const result = spawnSync(probe, [executable], { encoding: "utf-8", timeout: 5000 });
				if (result.status === 0 && result.stdout) {
					const first = result.stdout.trim().split(/\r?\n/)[0];
					if (first && existsSync(first)) return first;
				}
			} catch {
				// Probe unavailable; try the next one.
			}
		}
		return undefined;
	},
};

/** Native parity: the exact argv prefix of pi's built-in powershell tool. */
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Native parity: prepended to every PowerShell command (UTF-8 console output). */
export const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/**
 * Detached pwsh exit-code trailer. The command runs inside `& { … }`; process
 * exit through Invoke-Expression does not propagate failure codes (measured:
 * native exit 7 → 0, failing cmdlet → 0), so the trailer converts the shell's
 * own state to an explicit exit: failing pipeline → 1, else the last native
 * command's code, else 0. Measured on 5.1 and 7 (ADR-0009).
 */
export const PWSH_EXIT_TRAILER =
	"; if (-not $?) { exit 1 } elseif (Test-Path variable:LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }";

/** Env var carrying the command to a detached pwsh wrapper (no argv quoting). */
export const PWSH_DETACHED_ENV = "PI_BG_SHELL_CMD";

/** Fixed inner invocation for detached pwsh — never contains dynamic text. */
export const PWSH_DETACHED_INNER = "Invoke-Expression $env:PI_BG_SHELL_CMD";

/** Classify a win32 bash path: the System32 relay needs WSL treatment. */
export function bashFlavorFor(bin: string): "wsl-bash" | "windows-bash" {
	return /(^|[\\/])system32[\\/]bash\.exe$/i.test(bin) ? "wsl-bash" : "windows-bash";
}

function noBashError(gitCandidates: string[]): Error {
	return new Error(
		`No bash shell found. Options:\n` +
			`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
			`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
			`  3. Set shellPath in settings.json\n\n` +
			`Searched Git Bash in:\n${gitCandidates.map((p) => `  ${p}`).join("\n")}`,
	);
}

/** Resolve the bash spec the way pi's native bash tool does (ADR-0009). */
export function resolveBashSpec(
	settings: ShellSettings = {},
	io: ShellIo = realIo,
	platform: NodeJS.Platform = process.platform,
): ShellSpec {
	if (settings.shellPath !== undefined && settings.shellPath !== "") {
		if (!io.exists(settings.shellPath)) {
			throw new Error(`Custom shell path not found: ${settings.shellPath}`);
		}
		return {
			name: "bash",
			bin: settings.shellPath,
			flavor: platform === "win32" ? bashFlavorFor(settings.shellPath) : "posix-bash",
			args: ["-c"],
		};
	}
	if (platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles !== undefined && programFiles !== "") candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86 !== undefined && programFilesX86 !== "") {
			candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}
		for (const candidate of candidates) {
			if (io.exists(candidate)) return { name: "bash", bin: candidate, flavor: "windows-bash", args: ["-c"] };
		}
		const onPath = io.which("bash.exe");
		if (onPath !== undefined) return { name: "bash", bin: onPath, flavor: bashFlavorFor(onPath), args: ["-c"] };
		throw noBashError(candidates);
	}
	if (io.exists("/bin/bash")) return { name: "bash", bin: "/bin/bash", flavor: "posix-bash", args: ["-c"] };
	const onPath = io.which("bash");
	if (onPath !== undefined) return { name: "bash", bin: onPath, flavor: "posix-bash", args: ["-c"] };
	return { name: "bash", bin: "sh", flavor: "posix-bash", args: ["-c"] };
}

/** Resolve PowerShell the way pi's native powershell tool does: pwsh first. */
export function resolvePowerShellSpec(io: ShellIo = realIo, platform: NodeJS.Platform = process.platform): ShellSpec {
	if (platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}
	const bin = io.which("pwsh.exe") ?? io.which("powershell.exe");
	if (bin === undefined) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}
	return { name: "pwsh", bin, flavor: "powershell", args: [...POWERSHELL_ARGS] };
}

/** Command string for a normal (non-detached) run: pwsh gets the UTF-8 header. */
export function composeNormalCommand(spec: ShellSpec, command: string): string {
	return spec.flavor === "powershell" ? UTF8_OUTPUT_PREFIX + command : command;
}

/**
 * Env value for a detached pwsh task: UTF-8 header + the command in a block +
 * the exit-code trailer. Traveling as an env var means no quoting anywhere on
 * the wscript → cmd → pwsh chain (ADR-0009).
 */
export function composePwshDetachedCommand(command: string): string {
	return `${UTF8_OUTPUT_PREFIX}& { ${command}\n}${PWSH_EXIT_TRAILER}`;
}
