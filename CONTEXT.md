# pi-bg-shell

Pi 编码 agent 的后台 shell 任务扩展。本文档是项目的**术语表（ubiquitous language）**，只定义概念，不含实现细节；代码、ADR、讨论共用这套词汇。

## 任务与生命周期

**后台任务**：
`bash_bg` 启动的一条 shell 子进程及其登记信息（id、pid、状态、输出缓冲、超时）。id 是进程内单调递增整数，对话中以 `#N` 指代。
_Avoid_: 子 agent（那是 pi-subagents 的完整 agent 会话；后台任务是裸进程）、作业/job（统一叫任务）。

**任务状态**：
五值：`running` / `completed`（退出码 0）/ `failed`（非 0 或 spawn 失败）/ `killed`（被 `bg_kill`）/ `timeout`（超时击杀）。
_Avoid_: 成功/失败对（failed 覆盖 spawn 错误，不只是非零退出；killed 与 failed 严格区分——前者是主动终止）。

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

**exit 钩子**：
注册表上的 `onExit(snapshot, output)`，入口工厂每次加载重绑到当前 runtime 的 notifier（PITFALLS P1 的防线本体）。
_Avoid_: 监听器（会被误解为 DOM 式多播；它是单槽、可覆盖）。
