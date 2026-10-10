import assert from "node:assert/strict";
import test from "node:test";
import {
	bashFlavorFor,
	composeNormalCommand,
	composePwshDetachedCommand,
	PWSH_DETACHED_ENV,
	PWSH_EXIT_TRAILER,
	resolveBashSpec,
	resolvePowerShellSpec,
	UTF8_OUTPUT_PREFIX,
	type ShellIo,
} from "../extensions/bg-shell/shell.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const GIT_BASH_X86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
const WSL_RELAY = "C:\\WINDOWS\\system32\\bash.exe";
const CYGWIN_BASH = "C:\\cygwin64\\bin\\bash.exe";
const PWSH7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const PS51 = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function io(existsPaths: string[] = [], whichMap: Record<string, string> = {}): ShellIo {
	return {
		exists: (path) => existsPaths.includes(path),
		which: (name) => whichMap[name],
	};
}

const WIN = "win32" as NodeJS.Platform;
const LINUX = "linux" as NodeJS.Platform;

test("win32 bash resolution mirrors the native order: shellPath, Git Bash, PATH", () => {
	// 1. shellPath wins when it exists; flavor follows the path (relay => wsl).
	const viaSetting = resolveBashSpec({ shellPath: WSL_RELAY }, io([WSL_RELAY]), WIN);
	assert.equal(viaSetting.bin, WSL_RELAY);
	assert.equal(viaSetting.flavor, "wsl-bash");

	// 2. shellPath that does not exist fails like native.
	assert.throws(() => resolveBashSpec({ shellPath: "D:\\nope\\bash.exe" }, io([]), WIN), /Custom shell path not found/);

	// 3. Git Bash under Program Files beats anything on PATH.
	const gitFirst = resolveBashSpec({}, io([GIT_BASH], { "bash.exe": WSL_RELAY }), WIN);
	assert.equal(gitFirst.bin, GIT_BASH);
	assert.equal(gitFirst.flavor, "windows-bash");

	// 4. x86 Git Bash is the second candidate.
	const gitX86 = resolveBashSpec({}, io([GIT_BASH_X86]), WIN);
	assert.equal(gitX86.bin, GIT_BASH_X86);

	// 5. PATH fallback: the System32 relay classifies as WSL, others don't.
	assert.equal(resolveBashSpec({}, io([], { "bash.exe": WSL_RELAY }), WIN).flavor, "wsl-bash");
	assert.equal(resolveBashSpec({}, io([], { "bash.exe": CYGWIN_BASH }), WIN).flavor, "windows-bash");

	// 6. Nothing found: native-style error listing what was searched.
	assert.throws(() => resolveBashSpec({}, io([]), WIN), /No bash shell found[\s\S]*git-scm.com[\s\S]*Searched Git Bash in:/);
});

test("posix bash resolution mirrors the native order: /bin/bash, PATH, sh", () => {
	assert.equal(resolveBashSpec({}, io(["/bin/bash"]), LINUX).bin, "/bin/bash");
	assert.equal(resolveBashSpec({}, io([], { bash: "/usr/local/bin/bash" }), LINUX).bin, "/usr/local/bin/bash");
	const sh = resolveBashSpec({}, io([]), LINUX);
	assert.equal(sh.bin, "sh");
	assert.equal(sh.flavor, "posix-bash");
	assert.deepEqual(sh.args, ["-c"]);
});

test("powershell resolution prefers pwsh.exe then falls back to powershell.exe", () => {
	const both = resolvePowerShellSpec(io([], { "pwsh.exe": PWSH7, "powershell.exe": PS51 }), WIN);
	assert.equal(both.bin, PWSH7);
	assert.equal(both.flavor, "powershell");
	assert.deepEqual(both.args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);

	const fallback = resolvePowerShellSpec(io([], { "powershell.exe": PS51 }), WIN);
	assert.equal(fallback.bin, PS51);

	assert.throws(() => resolvePowerShellSpec(io([]), WIN), /No PowerShell executable found/);
	assert.throws(() => resolvePowerShellSpec(io([]), LINUX), /only available on Windows/);
});

test("command composition: pwsh gets the native UTF-8 prefix; detached rides env + trailer", () => {
	const pwsh = resolvePowerShellSpec(io([], { "pwsh.exe": PWSH7 }), WIN);
	assert.equal(composeNormalCommand(pwsh, "Get-Date"), `${UTF8_OUTPUT_PREFIX}Get-Date`);
	assert.equal(composeNormalCommand({ name: "bash", bin: "bash", flavor: "posix-bash", args: ["-c"] }, "ls"), "ls");

	const detached = composePwshDetachedCommand("Write-Output ok");
	assert.ok(detached.startsWith(UTF8_OUTPUT_PREFIX), "console encoding is pinned first");
	assert.ok(detached.includes("& { Write-Output ok\n}"), "command runs inside a block");
	assert.ok(detached.endsWith(PWSH_EXIT_TRAILER), "exit code comes from the trailer, not the process exit");
	// The env contract is a fixed name — wrappers and host must agree on it.
	assert.equal(PWSH_DETACHED_ENV, "PI_BG_SHELL_CMD");
});

test("bashFlavorFor classifies only the System32 relay as WSL", () => {
	assert.equal(bashFlavorFor(WSL_RELAY), "wsl-bash");
	assert.equal(bashFlavorFor("C:\\Windows\\System32\\Bash.EXE"), "wsl-bash");
	assert.equal(bashFlavorFor(GIT_BASH), "windows-bash");
	assert.equal(bashFlavorFor(CYGWIN_BASH), "windows-bash");
});
