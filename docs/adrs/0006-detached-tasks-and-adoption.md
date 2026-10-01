# 6. 脱离任务：detached spawn + 清单领养，任务活过会话退出

Date: 2026-10-02

## Status

Accepted

## Context

ADR-0003 挂账的「detached 孤儿模式 + 跨会话 reattach」在反馈轮拿到真实场景：24h 级 runner 挂在会话里，pi 一退全死，使用者只能叮嘱「电脑别关、会话别关」。需求边界：**救「会话关闭」，救不了「关机/重启」**——后者物理无解，答案是把长任务放到常开机器上跑。

工程约束：pi 退出后本扩展的 Node 进程就没了，管道、内存缓冲、close 事件全部失效；新会话对非子进程没有 waitpid 权限（拿不到退出事件与退出码）。另外双 fork/setsid 之后子进程是新进程组长，kill 负 pid 才能连子孙一起管。

## Decision

`bash_bg { detach: true }` 走独立 spawn 路径（ADR-0006 语义）：

1. **spawn**：`spawn("bash", ["-c", wrapped], { detached: true, stdio: ["ignore", outFd, errFd] })` + `unref()`。stdio 直写 tmpdir 下 `pi-bg-shell/` 目录里的 0600 文件（该目录 0700）——文件本身就是全量输出，天然跨会话。
2. **真实退出码**：wrapped = `( <command>\n)\nprintf '%s\n' "$?" > statusPath`。包装 bash 自身恒以 0 退出，业务码由 printf 落盘；本会话用 close 事件判死、状态文件取码，被领养任务用轮询。
3. **清单（manifest）**：每任务一个 JSON（pid、command、cwd、startedAt、hostname、三个文件路径、pattern 的 literal/all/**fired**）。quit 对运行中的脱离任务**不杀不清**——清单与输出文件留给下个会话。
4. **领养**：`session_start` 时 `adoptDetached()` 扫描清单目录；hostname 不符跳过；pid 死亡（DOA）则静默登记终态（用状态文件恢复退出码，**不唤醒**）；活着则注册为 running 任务，2 s 轮询做死亡检测 + 增量喂 `LineMatcher`（on_pattern 跨会话续效）。single-shot 模式唤醒过一次即把 `fired: true` 持久化回清单；领养时回放历史输出——若「从未投递且已命中」则补发一次陈旧唤醒，若早已投递过则只恢复计数不重复吵。
5. **默认超时对 detach 关闭**（显式 `timeout_sec` 仍生效）：10 分钟默认杀 24h 任务与脱离语义直接矛盾。`bg_kill` 对脱离任务发 `kill(-pid)`（进程组）。

## Considered Options

- **`bg_attach` 显式工具**——多一个工具面与一步模型配合；自动领养零交互且 bg_status 天然可见。显式 attach 留作将来需要「挑着认领」时再加。
- **跨会话唤醒通知（dead-on-arrival 也唤醒）**——session_start 时刻批量陈旧死亡会直接轰炸新会话；静默登记 + bg_status 可查更稳。
- **不做退出码包装、只报「死了」**——丢失成败信息，agent 被迫猜；printf 落盘一行解决。
- **PID 文件 + 纯双 fork（无清单）**——没有输出文件路径/hostname/pattern 状态可认领，信息不足。
- **长轮询间隔（30 s+）**——交互感差；2 s 的 syscall 开销可忽略（unref 计时器，无任务即停）。

## Consequences

- 正面：24h runner 不再绑定会话生死；输出/退出码/模式监视全部跨会话续传；机器重启后清单残留会被下次启动的 DOA 路径静默清理。
- 负面/接受：**关机仍会杀任务**（明确边界）；PID 复用在「进程死、状态文件未写、pid 被复用」的窗口内可能误判存活（状态文件是权威死讯，窗口 ≤ 轮询间隔）；同一清单被两个并存 pi 会话同时领养会双份跟踪（单机单会话为主流，未做互斥）；wrapped 的 `( … )` 在命令尾部带 `#` 注释时会被注释吞掉右括号（罕见，症状是退出码缺失）；POSIX only（setsid、kill(-pid)、bash）。
- 后续候选：`bg_attach` 显式认领、清单互斥锁、输出文件轮转。
