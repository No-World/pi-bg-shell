# PITFALLS

已知坑位手册。每条按 **Trap / Why / Avoid / Recovery** 四段；正文一句话可讲清的教训不单独立条。

## 入库门槛

满足其一才立条（宁缺毋滥）：

- 踩过至少一次且有可复现路径；
- 错误信息具有误导性（报 A 实为 B）；
- 防线不在本仓、只能靠「知道」来规避。

不满足的写进 ADR 的 Consequences 或代码注释即可。

## 条目

### P1: 扩展 reload 后，后台任务的完成通知静默丢失

**Trap**: 任务注册表为跨 reload 存活挂在 `globalThis[Symbol.for(...)]`（ADR-0003），但完成回调 `registry.onExit` 若绑定的还是旧 runtime 的 notifier，`/reload` 之后旧 `pi.sendMessage` 引用指向已替换的扩展运行时——任务照常退出、状态照常落盘，agent 却永远收不到通知，表现为「后台任务完成了但没人理」。

**Why**: reload 重新求值模块，旧闭包里的 `pi` 已随旧 runtime 失效；注册表存活恰恰放大了这个问题（没有「任务也没了」的显式信号）。

**Avoid**: 入口工厂每次加载**无条件重绑** `registry.onExit` 指向新 notifier（`extensions/bg-shell/index.ts` 已如此；改动入口时保持该顺序）。

**Recovery**: 若发现通知丢失，用 `bg_status` 查任务真实状态即可补齐信息；通知本身不承担唯一事实源职责。

### P2: node --test 直跑 TS 只支持可擦除语法

**Trap**: 测试与被测扩展源码都由 Node 原生 type-stripping 执行（`node --test tests/*.test.ts`）。`enum`、命名空间、`constructor(private readonly x)` 参数属性等**不可擦除**语法会让整个文件加载失败，报错指向语法位置而非「不支持该特性」，容易被误判为写错了地方。

**Why**: type-stripping 只删类型注记，不做代码生成；参数属性需要生成赋值语句，故被排除。

**Avoid**: 扩展代码统一用「显式字段 + 构造函数赋值」；需要枚举时用 `as const` 对象 + 派生联合类型。

**Recovery**: 加载失败时先扫这两个语法点（`grep -n "constructor(.*private\|enum "`），再查其他。

### P3: sendMessage 在会话切换边缘可能被拒

**Trap**: `pi.sendMessage(..., {triggerTurn: true})` 在会话正在切换/关闭的窗口内可能抛异常；此时后台任务的输出若无兜底将永久丢失。

**Why**: 消息要进入会话转录，切换中的会话没有稳定落点；pi-subagents 的 completion 路径同样以 try/catch 包裹。

**Avoid**: 所有 sendMessage 调用走 CompletionNotifier 的「一次有界重试」路径，不要绕过它直接调 `pi.sendMessage`。

**Recovery**: 重试仍失败时输出并未丢——溢写文件与 `bg_status` 仍是事实源；agent 下次查询即可找回。

### P4: 脏工作树上跑门禁会给出假绿（提交缺失文件，本地却全过）

**Trap**: 按仓库规矩用显式路径 `git add <paths>` 暂存，漏掉某个已改文件（如测试工厂的类型字段补丁）；随后在工作树上跑 `npm test && npm run typecheck` 全绿——验证的是「工作树」而不是「提交」。推送后 CI checkout 纯提交即炸（PR #8/#9 首轮 TS2322，2026-10-01）。

**Why**: typecheck/测试读的是磁盘文件，与暂存区/提交内容无关；显式路径暂存与脏树验证叠加，恰好把缺口藏到 push 之后。

**Avoid**: 提交后、push 前对**提交内容**跑一次门禁：`git stash -u && npm test && npm run typecheck && git stash pop`，或 checkout 到提交上验证；栈式多提交时逐提交验证（`git rebase -i` 的 edit 停点处跑）。

**Recovery**: CI 红了先比对 `git diff <CI上的提交> --stat` 与工作树；缺失文件补回对应栈层（rebase edit + amend），force-push 前逐提交重验。
