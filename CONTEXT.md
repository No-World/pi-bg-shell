# pi-bg-shell

Pi 编码 agent 的后台 shell 任务扩展。本文档是项目的**术语表（ubiquitous language）**，只定义概念，不含实现细节；代码、ADR、讨论共用这套词汇。

## 任务与生命周期

**解释器规格（ShellSpec）**：
`bash_bg` / `powershell_bg` 实际使用的解释器描述：名称（bash/pwsh）、二进制路径、argv 前缀、**风味**（flavor：posix-bash / wsl-bash / windows-bash / powershell）。bash 的解析顺序镜像 pi 原生 `bash` 工具（shellPath → Git Bash → PATH），PowerShell 镜像原生 `powershell` 工具（pwsh 优先）；agent 通过挑工具选解释器，不存在 per-call 参数（ADR-0009）。
_Avoid_: shell 参数/PI_BG_SHELL（都是被否决的方案：原生没有对应机制）、cmd（原生无 cmd 工具，明确不支持）。

**WSL 中继**：
PATH 上 `C:\Windows\System32\bash.exe` 的角色——把 Windows 侧 spawn 翻译进 WSL。作为 bash 解析的最后兜底（不再是 Windows 默认）；其 detached 路径需要 `/mnt/<drive>/` 路径翻译且包装层绝不能走 `-c` argv（P6）。
_Avoid_: Windows bash（那会与 Git Bash/Cygwin/MSYS2 混淆——它们是 windows-bash 风味，无需翻译）。

**windows 原生 bash（windows-bash）**：
Git Bash / Cygwin / MSYS2 / 自定义 `shellPath` 一类——能直接寻址 `C:/…` 路径的原生 Windows bash；detached 包装层与 WSL 中继同形但零翻译（ADR-0009）。
_Avoid_: Git Bash 专属（不止 Git Bash，Cygwin/MSYS2 同类）。

**powershell_bg**：
`bash_bg` 的 PowerShell 兄弟工具：仅 win32 注册、默认 inactive（与原生 `powershell` 同经 `defaultTools` 激活）、pwsh→powershell 回退、UTF-8 控制台头前置。detached 走静态 `.cmd` 包装 + `PI_BG_SHELL_CMD` 环境变量传命令（全程零动态引号）。
_Avoid_: bash_bg 的 shell 参数（不存在；选解释器 = 挑工具）、cmd_bg（明确不做）。

**PI_BG_SHELL_CMD**：
pwsh detached 的命令传输通道：宿主在 spawn 环境里注入「UTF-8 头 + `& { 命令 }` + 退出码 trailer」的复合串，经 wscript → cmd → pwsh 一路继承，由固定串 `Invoke-Expression $env:PI_BG_SHELL_CMD` 执行——绕开整条链上的引号问题与 5.1 的 UTF-16 重定向坑（ADR-0009）。
_Avoid_: argv 传参（P6 类风险就是它要消灭的）。

**后台任务**：
`bash_bg` 启动的一条 shell 子进程及其登记信息（id、pid、状态、输出缓冲、超时）。id 是进程内单调递增整数，对话中以 `#N` 指代。
_Avoid_: 子 agent（那是 pi-subagents 的完整 agent 会话；后台任务是裸进程）、作业/job（统一叫任务）。

**任务面板**：
`/bg` 拉起的 overlay 弹窗（列表 + 详情两视图），对齐 pi-subagents fleet 视图的交互（↑↓ 选、Enter 详情、K 杀、q 关）。所有查看类指令都落在这里，不往正文窗口回内容。
_Avoid_: fleet 视图（那是 subagent 的词；这里是任务面板）、列表命令（面板是弹窗不是列表输出）。

**状态窗**：
有任务运行时常驻输入框上方的卡片式 widget（表头 + 每任务一张卡：spinner/label/计时 + `cmd:` 原始命令 + `⎿ ↓ 总量 · 最新输出行`），表头与任务名白色、其余分区主题着色，按终端宽度截断，500ms 活重绘，无任务自动连 ticker 一起消失；fork 自 pi-subagents 的 async 卡片样式。
_Avoid_: 状态栏/footer（footer 是 pi 底栏；状态窗是输入框上方 widget）、toast（那是 notify 瞬时提示）、树形连接符/▶ 装饰与字节增量标注（v1/v2 遗留，已删）。

**任务状态**：
五值：`running` / `completed`（退出码 0）/ `failed`（非 0 或 spawn 失败）/ `killed`（被 `bg_kill`）/ `timeout`（超时击杀）。
_Avoid_: 成功/失败对（failed 覆盖 spawn 错误，不只是非零退出；killed 与 failed 严格区分——前者是主动终止）。

**脱离任务**：
`detach: true` 启动的任务：setsid 独立进程组、输出直写文件、真实退出码由包装 printf 落盘；pi 退出不杀不清，工件入全局池等订阅。救「会话关闭」，救不了「关机」。
_Avoid_: 孤儿进程（那是指无人收尸的失控进程；脱离任务有清单可认领）、守护进程（不自启、不重启，只存活）。

**全局池**：
`tmpdir()/pi-bg-shell/` 根目录——机器级任务公告板（ADR-0007）：清单记录 sessionId 与创建进程，所有会话可见。同 sessionId 的会话开局自动重订阅；异会话可见但需显式认领；无人见证的终态由扫描会话合并补发一次（`unattended` 标注，`.reported` 标记幂等）；工件回收条件 = 终态 + 已汇报 + 无活订阅 + 创建进程消失。
_Avoid_: 任务池（旧词，指 #19 时代的每进程私有池——已废止）、共享注册表（注册表仍是每会话内存态，池只是磁盘工件）。

**清单文件**：
脱离任务的认领凭据（tmpdir 下 0600 JSON）：pid、命令、三个文件路径、hostname、**创建进程 pid + sessionId**、pattern 的 fired 状态；配套标记文件（`.fired` / `.sub.<pid>` / `.reported` / `.killedby`）与输出同居。清单不再被领养改写——订阅只写标记。
_Avoid_: PID 文件（只存 pid 不够认领）、配置文件（它是运行时凭据不是配置）。

**领养**：
会话把池任务接入自己注册表的动作（ADR-0007 订阅模型）：同 sessionId 开局自动发生，异会话经 bg_adopt 显式发起；写入 `.sub.<pid>` 标记（wx 独占，无锁无竞态），随后独立轮询、独立唤醒、杀权共享（kill 写 `.killedby` 归因）。旧「属主独占转移」已废止。
_Avoid_: bg_attach（V1 未提供的旧设想名，工具名定为 bg_adopt）、抢占（订阅是加法不是转移，旧订阅者不丢失任何东西）、重连（没有连接，是重新观察）。

**尾部缓冲**：
每流（stdout/stderr）1 MiB 的内存缓冲，只保留末尾；内存中超出即触发溢写。
_Avoid_: 全量缓存（无界内存是事故配方）、日志（那是溢写文件的职责）。

**溢写文件**：
尾部缓冲首次溢出时，把已捕获的**全部**输出落入 tmpdir 下的文件并持续追加；「溢写文件 + 内存尾部」恒等于完整输出。自然完成的任务保留溢写文件供 agent 事后读取；quit/清理时删除。
_Avoid_: 日志文件（对用户而言这是输出的完备副本，不是运维日志）、截断文件（不是截断，是全量）。

**驻留注册表**：
挂在 `globalThis[Symbol.for("pi-bg-shell.registry.v1")]` 的任务表，跨扩展 reload 存活（ADR-0003）；quit 时销毁并杀光子进程。
_Avoid_: 单例（代码里的 singleton 指注册表，但「驻留」强调它活过 runtime 替换这一非显然事实）。

## 唤醒

**完成通知**：
任务退出后经 100 ms debounce 合并，以 `customType: "bg-shell-notify"` 的 custom message + `triggerTurn: true` 送进对话的消息；空闲会话直接触发新一轮 agent 运行，busy 会话由 pi 排队。
_Avoid_: 推送/push（不是网络语义）、回调（那是实现层 `onExit` 钩子）。

**唤醒风暴**：
并行任务同时退出时逐条 triggerTurn 导致 agent 连开多轮的现象；debounce 合并窗口是其防线。
_Avoid_: 风暴合并（合并是手段，风暴才是问题名）。

**模式唤醒**：
`on_pattern` 的字面子串、逐行（grep 语义）监视；默认 single-shot——首次命中唤醒一次，后续命中仍计数（`running·matched×N`）但不再唤醒；`all` 模式（`on_pattern_all`）改为每次命中都唤醒，带最小间隔（默认 10s）频率防护；`stop` 模式在投递后停任务。常驻守望必须用 `all` 模式（AGENTS.md 三律③）。
_Avoid_: 触发器（那是调度器词汇；这里只改交付时机）、正则（显式取舍：字面匹配就够，转义坑不背）。

**进度报告**：
`report_every_sec` 的运行中心跳：每 N 秒投递「已运行时长 + 输出尾部」，不中断任务；任务退出即停。
_Avoid_: 轮询（报告是推送，不是 agent 主动查）、心跳检测（那是存活探测语义，报告携带的是内容）。

**exit 钩子**：
注册表上的 `onExit(snapshot, output)`，入口工厂每次加载重绑到当前 runtime 的 notifier（PITFALLS P1 的防线本体）。
_Avoid_: 监听器（会被误解为 DOM 式多播；它是单槽、可覆盖）。

**守望任务**：
以 `on_pattern` 告警为唯一目的的长寿命后台任务。规约形态 = 常驻（`timeout_sec: 0`）+ `on_pattern_all` 唤醒 + 脚本内自限速（状态转移或最小间隔才 echo 标记），见 AGENTS.md「BG Task Protocol」第 3 条；需要跨 pi 会话存活的守望加 `detach: true`，下个会话自动领养、pattern 续效。
_Avoid_: 轮值守望（触发即退 + 人工重臂，被三律③禁掉的反模式，不是守望的合法形态）、单发守望（普通 `on_pattern` 只醒一次，之后静音但看着还在布防——比轮值更危险）、定时任务/cron（守望是条件触发，不是时间调度）。
