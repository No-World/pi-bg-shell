# 3. 后台 shell 的唤醒机制：sendMessage + triggerTurn

Date: 2026-09-30

## Status

Accepted

## Context

目标是对齐 Claude Code 的后台 shell 体验：`bash` 立即返回、agent 继续干别的活、命令退出后输出**自动**送回 agent。pi 的扩展面没有「后台任务完成回调进对话」的一等 API，但存在一条被两处先例验证的原语路径：`pi.sendMessage({customType, content, display}, {triggerTurn: true})`——空闲会话直接触发新一轮 agent 运行，busy 会话由 pi 排队（官方 file-trigger 示例与 pi-subagents 的 completion 通知 notify.js 都走这条路）。

同时存在两个工程约束：

1. **reload 存活**：pi 的 `/reload` 重新求值扩展模块，模块级状态清零，但 `globalThis` 上的 `Symbol.for` 键存活——pi-subagents 用同一技巧保住 completion registry。
2. **唤醒风暴**：并行 fan-out 的多条任务同时退出时，每条一个 triggerTurn 会连开多轮 agent；pi-subagents 用 completion-batcher 合并，证明需要 debounce。

## Decision

1. **唤醒走 `pi.sendMessage` custom message（`customType: "bg-shell-notify"`）+ `{triggerTurn: true}`**，完成回调在进程 exit 事件里触发，不做轮询。
2. **任务注册表挂在 `globalThis[Symbol.for("pi-bg-shell.registry.v1")]`**，跨 reload 存活；入口工厂每次加载重绑 `registry.onExit` 指向新 notifier，防止旧 runtime 的回调随旧 API 一起失效。
3. **完成通知 100ms debounce 合并**：窗口内多条退出合成一条 grouped 消息，单次 triggerTurn。
4. **生命周期**：`session_shutdown` 且 `reason === "quit"` 时 SIGTERM+SIGKILL 全部子进程并删溢写文件；`reload/new/resume/fork` 一律保留（注册表继续活着）。
5. 内置 `bash` 工具不动，新注册独立的 `bash_bg` / `bg_status` / `bg_kill` 三个工具；输出用「内存尾部缓冲（1 MiB/流）+ 首次溢出即全文溢写文件」策略。

## Considered Options

- **纯轮询**（只给 `bg_status`，不自动唤醒）——实现最简，但 agent 必须自己记得回头查，长任务下上下文窗口里容易遗忘，正是 Claude Code 已淘汰的形态。
- **`pi.sendUserMessage` 注入**——以用户身份触发 turn 语义过重（对话历史里出现假用户消息），且 busy 时行为不同（需显式 deliverAs）。
- **复用 pi-subagents 的 async delegate**——机制现成，但一个完整子 agent 会话只为跑一条 shell，开销与语义都不匹配；且引入对另一扩展的运行时耦合。
- **包装内置 bash 加 `run_in_background` 参数**（bash-spawn-hook 式替换）——更贴近 Claude Code 的单工具形态，但要复刻内置工具的权限/渲染/更新流，V1 复杂度不值；独立工具名反而让模型的选择面更清晰。

## Consequences

- 正面：agent 启动后台任务后完全自由；完成即醒，无需人工戳；reload 不丢任务；风暴有 debounce 兜底。
- 负面/接受：`sendMessage` 的 options 形状属扩展 API 契约，pi 大版本变动时需回归（测试用注入的 send 函数锁定形状）；quit 前未 flush 的通知丢失（flushNow 尽力而为）；子进程随 pi 进程组退出，pi 崩溃时可能有孤儿——OS 层 tmp 清理兜底溢写文件。
- 后续候选：detached 孤儿模式 + 跨会话 reattach、通知渲染器（`registerMessageRenderer`）、默认超时可配置化——均留待真实使用反馈。
