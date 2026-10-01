# pi-bg-shell

Pi 编码 agent 的后台 shell 任务扩展。本文档是项目的**术语表（ubiquitous language）**，只定义概念，不含实现细节；代码、ADR、讨论共用这套词汇。

## 任务与生命周期

**后台任务**：
`bash_bg` 启动的一条 shell 子进程及其登记信息（id、pid、状态、输出缓冲、超时）。id 是进程内单调递增整数，对话中以 `#N` 指代。
_Avoid_: 子 agent（那是 pi-subagents 的完整 agent 会话；后台任务是裸进程）、作业/job（统一叫任务）。

**任务面板**：
`/bg` 拉起的 overlay 弹窗（列表 + 详情两视图），对齐 pi-subagents fleet 视图的交互（↑↓ 选、Enter 详情、K 杀、q 关）。所有查看类指令都落在这里，不往正文窗口回内容。
_Avoid_: fleet 视图（那是 subagent 的词；这里是任务面板）、列表命令（面板是弹窗不是列表输出）。

**状态窗**：
有任务运行时常驻编辑器下方的多行 fleet 树 widget（表头 + 每任务一行 spinner/计时 + `⎿ ↓ +N` 活动行 + 尾行），500ms 活重绘，无任务自动连 ticker 一起消失；fork 自 pi-subagents 的 fleet-status 模式。
_Avoid_: 状态栏/footer（footer 是 pi 底栏；状态窗是 editor 下方 widget）、toast（那是 notify 瞬时提示）、状态条（那是旧的单行形态）。

**任务状态**：
五值：`running` / `completed`（退出码 0）/ `failed`（非 0 或 spawn 失败）/ `killed`（被 `bg_kill`）/ `timeout`（超时击杀）。
_Avoid_: 成功/失败对（failed 覆盖 spawn 错误，不只是非零退出；killed 与 failed 严格区分——前者是主动终止）。

**脱离任务**：
`detach: true` 启动的任务：setsid 独立进程组、输出直写文件、真实退出码由包装 printf 落盘；pi 退出不杀不清理，下个会话凭清单自动领养。救「会话关闭」，救不了「关机」。
_Avoid_: 孤儿进程（那是指无人收尸的失控进程；脱离任务有清单可认领）、守护进程（不自启、不重启，只存活）。

**清单文件**：
脱离任务的认领凭据（tmpdir 下 0600 JSON）：pid、命令、三个文件路径、hostname、pattern 的 fired 状态。quit 保留运行中任务的清单；死亡任务被领养或淘汰时清除。
_Avoid_: PID 文件（只存 pid 不够认领）、配置文件（它是运行时凭据不是配置）。

**领养**：
新会话 session_start 扫描清单目录收编脱离任务：活着的恢复跟踪与唤醒（含 on_pattern 续效与陈旧命中补发），死了的静默登记终态、不唤醒。reload 后注册表仍在，不重复领养。
_Avoid_: bg_attach（那是显式认领工具名，V1 未提供；自动领养不是 attach）、重连（没有连接，是重新跟踪）。

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
`on_pattern` 的字面子串、逐行（grep 语义）监视；首次命中即唤醒，任务继续运行，`stop` 模式在投递后停任务。命中次数在快照上作 running 的子状态呈现（`running·matched×N`）。
_Avoid_: 触发器（那是调度器词汇；这里只改交付时机）、正则（显式取舍：字面匹配就够，转义坑不背）。

**进度报告**：
`report_every_sec` 的运行中心跳：每 N 秒投递「已运行时长 + 输出尾部」，不中断任务；任务退出即停。
_Avoid_: 轮询（报告是推送，不是 agent 主动查）、心跳检测（那是存活探测语义，报告携带的是内容）。

**exit 钩子**：
注册表上的 `onExit(snapshot, output)`，入口工厂每次加载重绑到当前 runtime 的 notifier（PITFALLS P1 的防线本体）。
_Avoid_: 监听器（会被误解为 DOM 式多播；它是单槽、可覆盖）。
