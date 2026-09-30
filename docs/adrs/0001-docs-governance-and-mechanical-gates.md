# 1. 文档治理与机械门禁先行

Date: 2026-09-30

## Status

Accepted

## Context

仓库从第一天起就要有多会话协作的agent 维护。没有机械校验的文档约定（ADR 索引、术语表、坑位手册）会在几个会话内漂移：索引漏条目、死链、Status 写成自由文本。pi-asterisk-tui 已验证「约定 + `scripts/check-docs.mjs` 机械门禁并入 `npm test`」的模式能在无人监督下保持文档一致。

## Decision

照搬该模式：ADR（Nygard 四段式 + Considered Options）、`docs/PITFALLS.md`（Trap/Why/Avoid/Recovery）、`docs/postmortems/`（闭环）、根目录 `CONTEXT.md` 术语表（每条带 _Avoid_ 反义提示）；`check-docs.mjs` 校验链接存活、ADR 编号唯一且与索引一致、Status 合法、Considered Options 存在、postmortem 形状，随 `npm test` 强制执行。

## Considered Options

- 不设门禁，纯约定——已被多个仓库证伪，漂移不可避免。
- 用第三方 lint 工具——这些规则全是仓库特有结构，自写 200 行脚本更直接，且零依赖。
- 门禁放 CI only——本地 `npm test` 不过就推不出去，才不需要等 CI 转一轮才发现。

## Consequences

- 每次改 ADR 必须同步 `docs/adrs/README.md` 索引，门禁兜底。
- postmortem 必须回到 PITFALLS 落规则，双向互链由死链检查间接保障。
- 新增文档类别时需扩展 check-docs（保持机械、可自测）。
