# 2. PR 纪律与 CI 门禁 lane

Date: 2026-09-30

## Status

Accepted

## Context

单人 + agent 协作仓库的两大风险：agent 直推 main 绕过审查；PR 与 issue 脱钩导致历史无法追溯。pi-asterisk-tui 与 AgentCloudCity 实践出同一条 lane：`npm test && npm run typecheck` 本地与 CI 同清单，PR body 必须声明 issue 绑定，合并永远由人执行。

## Decision

代码改动一律 `type/scope/short-desc` 分支 → PR → 人审 → squash-merge；PR body 必含 `Closes #N` / `Refs #N` / `No-Issue: <reason>` 之一，`pr-issue-link` job 机械拒绝；CI lane（`.github/workflows/pr-checks.yml`）就是本地 gate 的镜像；agent 负责分支/提交/开 PR 与门禁证据，从不执行 `gh pr merge`。

## Considered Options

- 允许 docs-only 直推 main——保留此豁免（错字级），但凡有疑问就走 PR。
- 用 branch protection + CODEOWNERS 代替 body 校验——保护规则管不住「PR 无 issue 绑定」，两者互补而非替代。
- agent 代合并——明确禁止；「发新版」授权只覆盖 tag/publish 且排在人合之后。

## Consequences

- 每个到达 main 的改动都有 PR 记录与 issue 追溯。
- CI 在 `edited` 事件也跑（issue 绑定读 PR body，`synchronize` 不覆盖 body 编辑）。
- 发版流程（两段式：tag 只建 draft release，人点 publish 才发包）在首个 npm 版本发布前引入相应 workflow，本 ADR 不展开。
