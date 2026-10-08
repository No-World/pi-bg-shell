# 8. 两段式发版：tag 只出 draft release，点 publish 才触发 npm publish

Date: 2026-10-08

## Status

Accepted

## Context

首次 npm 发版前选定发版机制。硬约束：**npm publish 不可逆**——版本号一经占用永久占用，撤回只能 deprecate，不能复用。传统一次式流程（推 tag 即发包）里，「忘写 release notes」的后果是向全世界发出一个无说明的包。

可借鉴的已验证配方：pi-asterisk-tui 的两段式（其 ADR-0007），经 v0.9.x–v0.10.x 多轮发版验证。GitHub Actions + npm Trusted Publishing（OIDC）均已具备，无需 NPM_TOKEN 凭据管理。

## Decision

1. **tag 只造草稿**：推 `v*` tag 触发 `release-draft.yml`，`gh release create --draft --generate-notes`——可见的待办清单，不发包。
2. **publish 才发包**：GitHub Release 的 **published** 事件触发 `npm-publish.yml`：checkout 到 tag → `npm ci` → 版本一致性门禁（tag ↔ package.json，错分支切 tag 在此 fail fast）→ `npm test` + `typecheck` 门禁 → `npm publish --provenance --access public`。
3. **OIDC trusted publishing**：`id-token: write`，无 NPM_TOKEN secret；npmjs 侧预配置（owner No-World · repository No-World/pi-bg-shell · workflow `npm-publish.yml`）。**workflow 文件名被 npmjs 钉死，不可改名**——改名即静默失效。
4. **顺序纪律**（AGENTS.md Git & PR Discipline 同款）：version 变更走 PR → 维护者合入 → 才允许推 tag → 补 highlights → 维护者点 publish。tag 永远不先于 PR 合入。
5. 首版为 `v0.3.0`（维护者选定：项目已有 #15–#25 的实绩积累，0.1.0 低估了成熟度；npm 上无占用历史，首版号自由）。

## Considered Options

- **一次式（推 tag 即发包）**——忘写 notes 的后果是「裸发包」而不是「没发」；被两段式取代。
- **NPM_TOKEN secret**——凭据轮换与泄露面；OIDC trusted publishing 已可用且免凭据。
- **本地手动 `npm publish`**——不可审计、无 provenance、绕过门禁。
- **tag 即发包 + CI 后补 notes**——包已发出，notes 补写只是心理安慰。

## Consequences

- 正面：publish 仍不可逆，但失误窗口从「推 tag 瞬间」缩小到「维护者审完 draft 主动点 publish」；忘写 notes 的后果从「发出无说明的包」降级为「没发」；provenance 可溯源；无凭据管理负担。
- 负面/接受：维护者需在 npmjs 一次性预配置 trusted publishing（新包名需先占位配置）；`npm-publish.yml` 文件名永久锁定；发版多一步人工确认（有意的摩擦）。
