# 9. Windows shell 矩阵：对齐 pi 原生（解析镜像 + powershell_bg 兄弟工具）

Date: 2026-10-10

## Status

Accepted

## Context

bg-shell 在 win32 上把「bash」硬编码为裸 `spawn("bash", …)`——PATH 解析结果即 WSL 中继。而 pi 原生 `bash` 工具的解析顺序是 `shellPath` 设置 → Git Bash（Program Files）→ PATH 上的 `bash.exe`（WSL 中继只是最后兜底）。同一台装了 Git Bash 的机器上，前台命令跑 Git Bash、后台任务跑 WSL，环境分裂；没装 WSL 的纯 Windows 机器上 bash_bg 直接 ENOENT。另外原生还有可选的 `powershell` 工具（win32 only、pwsh.exe 优先回退 powershell.exe、`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`），后台任务没有对应物。维护者目标：**与原生差距尽量小，降低 agent 的理解压力**——agent 在前台学到的 shell 语义在后台应当原样成立。

原生事实（源码核verified）：`DEFAULT_TOOL_NAMES = ["read","bash","edit","write"]`，`powershell` 默认不激活，经 settings 的 `defaultTools`（如 `["+powershell"]`）启用；该机制同样能激活扩展注册的 inactive 工具。原生给每条 PowerShell 命令前置 `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}`；`shellCommandPrefix` 设置只作用于 bash 工具。

## Decision

对齐「原生有的一切」，不发明原生没有的机制（ADR-0009 的总原则）：

1. **`bash_bg` 的 shell 解析镜像原生 `getShellConfig`**：`shellPath`（经 `pi.getSettings()` 读取）→ `%ProgramFiles%[ (x86)]\Git\bin\bash.exe` → PATH 上的 `bash.exe`；找不到时报与原生同款错误（列出搜索过的路径 + 安装建议）。POSIX：`/bin/bash` → PATH bash → `sh`。解析出的 bash 归类为两种 flavor：WSL 中继（`system32\bash.exe`）与 windows 原生 bash（Git Bash/Cygwin/MSYS2/自定义 shellPath），detached 机制按 flavor 分支。
2. **新增 `powershell_bg` 兄弟工具**（不是 bash_bg 的参数）：仅 win32 注册、`defaultActive: false`，与原生 `powershell` 一样经 `defaultTools: ["+powershell_bg"]` 激活——一行配置同时点亮前台后台。解析 `pwsh.exe` ?? `powershell.exe`（族内 pwsh 优先），argv 与原生逐字一致；正常路径命令前缀原生同款 UTF-8 头。agent 按调用挑工具（bash_bg / powershell_bg），这就是原生版的「agent 选择解释器」。
3. **detached 按 flavor 分支**（win32）：
   - **wsl-bash**：现有机器不动（toWslPath 翻译 + wrapper.sh + VBS）。
   - **windows-bash**（Git Bash/Cygwin/MSYS2/自定义）：无需 `/mnt` 翻译——wrapper.sh 直接用正斜杠 Windows 路径（`C:/…` 三家 bash 都接受）；VBS 启动器参数化为解析出的 bin 全路径。
   - **powershell**：wrapper 用 **`.cmd` 文件**（wscript → `cmd /c wrapper.cmd` → pwsh）。命令经环境变量 `PI_BG_SHELL_CMD` 传入（值 = UTF-8 头 + `& { <command> }` + 退出码 trailer `; if (-not $?) { exit 1 } elseif (Test-Path variable:LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }`），pwsh 以固定串 `-Command "Invoke-Expression $env:PI_BG_SHELL_CMD"` 执行——全程零动态引号。stdout/stderr 用 cmd 的 `1>>/2>>` **原始字节**转储（PowerShell 5.1 自己的 `>>` 写 UTF-16LE+BOM，实测 `fffe 6800…`，必须绕开）；状态文件 `(echo %ERRORLEVEL%)>"…"`。
   - 三种 win32 flavor 的 detached 一律保留 wscript GUI 启动器（P8）；`taskkill /t /f` 对三种 flavor 通用。
4. **`shellCommandPrefix` 对齐**：bash_bg 生效（`\n` 拼接，同原生），powershell_bg 不生效（原生如此）。
5. **manifest 增加可选 `shell` 字段**（"bash"|"pwsh"，缺省视为 bash），snapshot 同步携带，bg_status 展示用；领养侧逻辑 shell 无关，零改动。
6. **不做 cmd**：原生没有 cmd 工具；现代 Windows 必有 powershell.exe，cmd 的 `%`/caret 转义是新的 P6 式雷区。

## Considered Options

- **bash_bg 增加 per-call `shell` 参数**——模型多一个旋钮，且与原生「挑工具而非传参」的交互习惯相悖；否。
- **`PI_BG_SHELL` 环境变量选默认 shell**——原生机制就是 settings（`shellPath`）+ 挑工具，扩展能直接读 `pi.getSettings()`，再造一个 env 是第二套真相；否（Rejected 备选，本 ADR 即其记录）。
- **支持 cmd.exe**——原生无对应物；否。
- **powershell_bg 默认激活**——原生 powershell 是 opt-in（`DEFAULT_TOOL_NAMES` 硬编码四件套、无平台魔法，源码 + 本机实证：无 defaultTools 时工具列表里没有 powershell）；照抄 opt-in。
- **detach 路径改用原生同款 spawn flags（`detached:false + windowsHide`，去掉 VBS）**——理论上 CREATE_NO_WINDOW 的私有隐藏控制台对「关终端杀树」同样免疫、父进程退出不连坐，且少一个临时文件。但本机实验证明 WSL interop harness 会把一切 Windows 子进程放进 kill-on-close Job（生产已验证的 VBS 机制在同一 harness 里同样全灭）——**生存性轴在此环境不可判定**，而用户可感知行为（静默）两种方案完全一致。不为不可见的内部简化重开 68 小时实战验证过的 P8 结论；否，留档于此。
- **PowerShell detached wrapper 用 .NET Process 起内层 pwsh + `CopyToAsync` 转储**——端到端实测出现非确定性挂起（同命令一次成功一次死锁）；否，改用 cmd 原始字节重定向方案（已实测：退出码 7/1/3/0/7 五例全对，中文 UTF-8 无 BOM，5.1 与 7 行为一致）。

## Consequences

- 正面：装 Git Bash 的机器前后台同环境；纯 Windows 机器 bash_bg 报原生同款可操作错误而非 ENOENT；一行 `defaultTools` 同时启用原生 powershell 与 powershell_bg；agent 只需理解「原生工具 + `_bg` 后缀」一条规则。
- 负面/接受：pwsh7 重定向的 stderr 会带 ANSI 颜色码（原生 powershell 工具管道输出同样如此， tails 里是纯展示问题）；`PI_BG_SHELL_CMD` 成为宿主与 wrapper 的内部契约（env 值 ≤32KB，超长命令会失败——正常任务不受影响）；退出码 trailer 使「native(7) 后跟成功 cmdlet」记 7（`$LASTEXITCODE` 粘滞，实测记录）；VBS/wscript 依赖保留。
- 后续待办：Windows 机器上 `npm test`（win32-skip 用例 + 新 flavor 用例）+ `pi --extension .` 手工冒烟（含 detach 后退出 pi 再领养）；README 双语与 CONTEXT.md 同步。
