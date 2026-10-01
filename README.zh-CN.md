# pi-bg-shell

[Pi 编码 agent](https://github.com/earendil-works/pi) 的后台 shell 任务扩展——Claude Code 式体验：启动命令、继续干活、命令退出时输出自动送回。

```
你:      跑一下测试套件，趁这个时间顺便起草 changelog
Agent:   bash_bg  →  Started background task #1 (pid 4242): npm test
Agent:   （继续写 changelog、回你消息、读文件……）
通知:    Background task #1 completed (exit 0, 42.1s): npm test
         --- stdout tail (1234/5678 bytes) ---
         ……
```

## 为什么需要它

Pi 内置的 `bash` 工具会阻塞整个 agent 轮次直到命令结束——两分钟的测试套件就是两分钟的会话冻结。`pi-bg-shell` 给 agent 三个工具，把长命令（构建、测试套件、dev server、文件监听）丢到后台，**命令一退出就自动唤醒** agent 并送上输出——不轮询、不蹲守。

## 工具

| 工具 | 作用 |
|------|------|
| `bash_bg` | 用 `bash -c` 后台执行命令，立即返回任务 id。每流 1 MiB 尾部缓冲捕获输出；超出即把全量历史溢写到文件。 |
| `bg_status` | 列出全部任务的单行摘要，或按 id 取单个任务的完整状态与输出尾部。 |
| `bg_kill` | 按 id 终止任务（默认 `SIGTERM`）。 |

完成通知以 `bg-shell-notify` 消息经 `pi.sendMessage({ triggerTurn: true })` 送进对话——与官方 file-trigger 示例、pi-subagents 的完成通知同一条唤醒原语。100 ms 窗口内的并发完成合并为一条消息，fan-out 不会冲垮会话。默认墙钟上限每任务 10 分钟（`timeout_sec` 可覆盖；`0` 关闭）。

### 任务还在跑时的唤醒

退出不再是唯一的交付时机（ADR-0005）：

- **`on_pattern`**——字面子串、逐行匹配（grep 语义）。首次命中即唤醒 agent，附命中行与输出尾部；任务**继续运行**。`on_pattern_all` 改为每次命中都唤醒（限频），`on_pattern_stop` 在投递命中后立即停掉任务。运行中 `bg_status` 显示 `running·matched×N` 子状态。
- **`report_every_sec`**——任务运行期间每 N 秒（钳到 ≥5）投递一份进度报告（已运行时长 + 输出尾部），不中断任务。

```
Agent:   bash_bg {command: "./day_runner.sh", timeout_sec: 0,
         on_pattern: "ROOTED", report_every_sec: 600}
Notify:  Background task #4 still running (600.2s elapsed, report every 600s): ./day_runner.sh …
Notify:  Background task #4 pattern match (on_pattern "ROOTED", match #1, running 1412.8s): ./day_runner.sh
         --- matched line (stdout) ---
         ROOTED device 3 ready
         …
```

两者都只控制「何时交付信息」，不是编排：被唤醒后的下一步仍由 agent 在对话里决定。

### 脱离任务（活过 pi 退出）

`bash_bg { detach: true }` 让命令在自己的 session（setsid）里跑，输出直写文件——退出 pi **不会杀它**（重启机器仍会）。真实退出码由包装层落盘；`tmpdir()/pi-bg-shell/` 下的清单让**下个 pi 会话自动领养**：活着的恢复跟踪（完成唤醒、on_pattern 继续监视），已死的静默登记终态供 bg_status 查。脱离任务默认不限时——需要限时就显式传 `timeout_sec`。

```
You:     把 24h 设备烤机跑起来，脱离，ROOTED 了叫我
Agent:   bash_bg {command: "./soak.sh", detach: true, on_pattern: "ROOTED"}
… pi 退出，次日重开 …
Notify:  Background task #1 pattern match (on_pattern "ROOTED", match #1, running 9h12m): ./soak.sh
```

`bg_kill` 对脱离任务发整进程组信号。

Windows 上 `bash` 通常是 WSL 中继，继承的 Windows 文件句柄跨不了这个边界——脱离任务在该平台改走 shell 自重定向（路径译为 `/mnt/<drive>/…`，`( cmd ) >> OUT 2>> ERR`），输出文件与退出码仍落在 `bg_status` 和下会话领养预期的位置。包装层本身以宿主侧脚本文件传递（`bash <file>`，不经 `-c` argv），退出码不会被 WSL 中继的参数重引号展开成 0。Windows 上 detached 中继改经 GUI 子系统的 wscript 启动器拉起——仅靠 `detached`+`windowsHide` 仍会弹控制台——因此启动零弹窗，且任务不再被「关闭终端窗口」连带杀死；`bg_kill` 在 Windows 上用 `taskkill /t /f` 整树终止（跨 WSL 边界没有 POSIX 信号语义）。自有脱离任务的 `on_pattern` 从第 0 字节起监视——启动早期的 milestone 同样会唤醒会话（领养任务另有全量回放）。任务池按 pi 进程隔离：清单记录属主进程，并存的 pi 进程不会碰属主存活的任务，只领养属主已消失的孤儿。

## 用户界面

任务运行期间，输入框上方常驻卡片式状态窗，每 500ms 重绘——计时逐秒在走、spinner 轮换，每张卡片带原始命令与当前输出及体量：

```
bg · background
   ⠸ #1 chatty-ticker · running · 1m 12s
     cmd: for i in $(seq 150); do echo …
     ⎿  ↓ 18.0k · [16:52:31] chatty heartbeat #93 …
   ⠋ #2 quiet-soak · running · 4m 2s
     cmd: sleep 300
 2 running · /bg panel
```

表头与任务名保持白色；装饰（`· running ·`、`cmd:`、`⎿`）dim，统计 muted，命令与实时输出行 toolOutput 色；每行按终端宽度截断。运行中任务超过六个折叠为 `… +N more`；最后一个任务结束后 widget 连同 ticker 一起消失。

所有查看类指令一律拉起弹窗面板，不往正文窗口灌内容：

| 指令 | 行为 |
|------|------|
| `/bg` | 弹窗面板：任务列表，`↑↓` 选择、`Enter` 详情、`K` 终止、`r` 刷新、`q`/`esc` 关闭 |
| `/bg <id>` | 直接打开该任务详情（状态、退出码、命令、输出尾部、溢写路径） |
| `/bg tail <id> [bytes]` | 同详情视图，可指定更大的尾部字节数（默认 4096） |
| `/bg log <id>` | 同详情视图；被截断的任务会展示全量输出的溢写文件路径 |
| `/bg kill <id> [signal]` | 终止任务（默认 `SIGTERM`），toast 确认 |

Tab 补全提供子命令与任务 id。无界面模式（RPC/JSON/print）退化为 notify 摘要。

## 安装

```bash
pi install git:github.com/No-World/pi-bg-shell
```

本地开发：

```bash
git clone https://github.com/No-World/pi-bg-shell
pi --extension /path/to/pi-bg-shell/extensions/bg-shell/index.ts
```

`/reload` 与会话切换保留运行中的任务；退出 pi 时 SIGTERM+SIGKILL 全部子进程并清理溢写文件。

## 配置

| 环境变量 | 作用 |
|---------|------|
| `PI_BG_SHELL_TIMEOUT_SEC` | 未传 `timeout_sec` 时的默认限时（秒）。默认 `600`；设为 `0` 关闭默认限时。在 pi 启动时读取一次，修改变量后需重启 pi 生效。 |

`bash_bg` 显式传入的 `timeout_sec` 永远优先于环境变量默认值。

## 唤醒机制

1. `bash_bg` 拉起子进程；工具结果瞬间返回。
2. 退出时注册表经 `onExit` 钩子发出最终快照。
3. debounce 窗口（100 ms）把并发完成合并成一条消息。
4. notifier 调 `pi.sendMessage(..., { triggerTurn: true })`——空闲会话直接开新一轮 agent 运行；busy 会话由 pi 排队。
5. agent 读到输出尾部（及全量输出的溢写文件路径），继续干活。

任务注册表挂在 `globalThis`（`Symbol.for` 键）上，跨扩展 reload 存活；入口工厂每次加载重绑 exit 钩子，reload 后的完成照样到达 agent。设计权衡记录在 [docs/adrs/0003-background-shell-wake-mechanism.md](docs/adrs/0003-background-shell-wake-mechanism.md)。

## 开发

```bash
npm install
npm test             # node:test 套件 + 机械文档门禁
npm run typecheck    # 严格 TypeScript 检查
npm run check:docs   # 单独跑文档门禁
pi --extension .     # 交互式体验
```

仓库带完整工程 harness：带机械索引门禁的 ADR（[docs/adrs/README.md](docs/adrs/README.md)）、坑位手册（[docs/PITFALLS.md](docs/PITFALLS.md)）、postmortem 闭环模板（[docs/postmortems/README.md](docs/postmortems/README.md)）、术语表（[CONTEXT.md](CONTEXT.md)），以及与本地门禁同清单的 CI lane（[.github/workflows/pr-checks.yml](.github/workflows/pr-checks.yml)）。贡献规则见 [AGENTS.md](AGENTS.md)。

## 许可

[MIT](LICENSE)
