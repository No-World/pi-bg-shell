# 4. 默认超时经 PI_BG_SHELL_TIMEOUT_SEC 环境变量配置

Date: 2026-10-02

## Status

Accepted

## Context

ADR-0003 把「默认超时可配置化」挂为留待真实使用反馈的候选。反馈到了：长任务（数小时级 runner）忘传 `timeout_sec` 时会被 600 s 默认值误杀——默认值对短命令是护栏，对长任务是把菜刀。需要一个不改变工具调用面的方式调整默认值。

## Decision

新增环境变量 `PI_BG_SHELL_TIMEOUT_SEC`：扩展加载时读取一次（`defaultTimeoutMsFromEnv`），作为 TaskRegistry 的 `defaultTimeoutMs`。缺失、非数值或负数回退 600 s；`0` 表示关闭默认超时（等价于所有任务默认不限时）。显式 `timeout_sec` 参数永远优先。

读取发生在共享注册表**首次创建**时：注册表跨 reload 存活（ADR-0003），改环境变量后需重启 pi 进程才生效。

## Considered Options

- **只靠 per-call `timeout_sec`（维持现状）**——零改动，但反馈证明模型会忘；误杀已经是真实事故。
- **配置文件（如 ~/.config/pi-bg-shell/config.json）**——能热改，但引入一个新配置面与解析/校验/文档负担，收益只有「免重启」。
- **pi settings / extension config API**——依赖宿主 API 稳定性，且当前扩展面没有一等 config 通道。
- **调高默认值（如 1 h）**——治标：任何固定值都会在另一端误伤（短任务护栏变弱或长任务仍被杀）。

## Consequences

- 正面：一行环境变量即可消除长任务误杀；语义零侵入（工具面不变）；`0` 给了「全手动」档。
- 负面/接受：进程级一次性读取，运行中改不生效（文档写明）；环境变量名成为对外契约，改名需走 deprecation。
- 关联：ADR-0003 的后续候选清单至此消化「默认超时可配置化」一项。
