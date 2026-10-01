# 5. 运行中事件投递：on_pattern 模式唤醒与 report_every 进度报告

Date: 2026-10-02

## Status

Accepted

## Context

真实使用反馈（2026-09 反馈轮）：为了让「日志出现 ROOTED 就叫醒 agent」，使用者被迫把 runner 写成「命中就 exit 0」借完成通知——杀掉了仍在跑的任务，有损。另一痛点：24h 级长任务运行期间对 agent 完全静默，agent 只能主动 bg_status 巡查（又是轮询）。两者的共同本质：**交付时机只有「任务退出」一种**。

同时有一条不能越的线（ADR-0003 与反馈轮的共同结论）：本扩展是执行器不是调度器。restart/cron/DAG 都被否了——编排决策应留在对话里，由被唤醒的 agent 做出。

## Decision

为运行中的任务增加两种**交付时机**事件，复用既有唤醒原语（sendMessage + triggerTurn + debounce 合并），任务本身不做任何新动作：

1. **`on_pattern`（模式唤醒）**：字面子串、行级匹配（grep 语义，含 \r\n 处理）；默认 single-shot——首次命中唤醒一次，后续命中仍计数（bg_status 显示 `running·matched×N`）但不再唤醒；`on_pattern_all` 改为每次命中都唤醒，带最小间隔（默认 10 s）频率防护；`on_pattern_stop` 在投递事件后走标准 kill 路径停掉任务（状态如实记 `killed`）。
2. **`report_every_sec`（进度报告）**：运行中每 N 秒（工具层钳到 ≥5 s）投递「已运行时长 + 输出尾部」，不中断任务；任务退出即停。

实现要点：`LineMatcher` 按流缓冲未完结行，超过 64 KiB 的无换行长行强制中途测试一次；事件经注册表单一 `onRunningEvent` 钩子送 notifier，与 `onExit` 同规则每次加载重绑（PITFALLS P1 对齐）；事件与完成通知共用 debounce 窗口合并。

**边界论证**：这两者只回答「何时把已有信息送给 agent」，不启动新工作、不隐藏决策——被唤醒后的下一步仍由 agent 在对话里决定。这与被拒绝的 schedule/DAG（替 agent 做编排决策）划清界限。

## Considered Options

- **正则匹配**——更强大，但转义与误匹配坑大；反馈明确「字面匹配就够（ROOTED）」。将来有需求再议，接口留的是 literal 字段。
- **全缓冲流式匹配（不限行）**——跨块边界的部分命中语义含糊（前缀命中算不算？），且无界；行级是 grep 的成熟语义。
- **命中后自动重启/续跑（自愈）**——越线成调度器；崩溃后续跑由被唤醒的 agent 决定（反馈轮已自证此用法成立）。
- **on_pattern 命中即默认杀任务**——反馈明确「命中后任务继续跑不杀」是主场景；杀停做成 opt-in 的 `on_pattern_stop`。

## Consequences

- 正面：日志监视类任务（设备 root、长时间烤机）不再需要「借 exit 0」的有损 hack；长任务有了心跳；频率防护防刷屏。
- 负面/接受：字面匹配不含正则能力（显式取舍）；`all` 模式的最小间隔意味着密集命中会漏报事件（计数仍完整，bg_status 可查）；`stop` 走 SIGTERM，依赖任务自身对信号的处理。
- 后续：detached 任务（ADR-0006 计划中）的轮询增量输出同样喂 LineMatcher，跨会话继续有效。
