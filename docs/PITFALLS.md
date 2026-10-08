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

### P5: Windows+WSL 下给 spawn("bash") 传 fd 或 Windows 路径，输出与退出码静默全断

**Trap**: detached 任务在 Windows 上把 Node `openSync` 的 fd 传给 `spawn("bash", …)` 的 stdio，并把 `C:\…` 路径写进 wrapper 的 printf 重定向——这里的 bash 实为 WSL bash.exe 中继（#15）。

**Why**: WSL 不翻译继承的 Windows 文件句柄（子进程 fd/1 落在控制台 pts，log 恒 0 字节）；`C:\…` 在 WSL 里不是合法路径（status 文件永不写 → "no exit" → 领养拿不到退出码）。非 detach 的管道 stdio 不受影响。

**Avoid**: 跨 WSL 边界只传**文本**不传句柄：路径经 `toWslPath` 译成 `/mnt/<drive>/…`，让 shell 自己 `>>`/`>` 重定向，stdio 全 ignore；不可翻译的路径（UNC 等）在创建任何工件前 fail-fast。

**Recovery**: 已断输出的 detached 任务无法补录，`bg_kill` 后重跑；孤儿工件在 tmpdir 的 `pi-bg-shell/` 会话子目录里，可手工清理。

### P6: WSL 中继把 `-c` argv 里的 "$?" 提前展开，退出码恒 0

**Trap**: win32 detached 任务把 wrapper（含 `printf '%s\n' "$?" > STATUS`）作为 `spawn("bash", ["-c", wrapper])` 的 argv 传给 WSL bash.exe；中继把 argv 重组进默认 shell 的命令行时给参数裹了**双引号**，`"$?"` 在外层 shell 解析时就被展开为其自身的 0——内层 bash 拿到的已是字面 `0`，status 文件永远写 0。症状酷似「包装 bash 自身恒 0 覆盖了业务码」，实为 argv 编组损坏（ps 看 bash argv 里是 `0` 而非 `$?` 即中招）。

**Why**: System32\bash.exe 不是 exec 直通，它把 Windows argv 拼回命令行交给 WSL 默认 shell 解释；双引号内的 `$?` 属于外层求值。CI 在 ubuntu 上永远走不到 win32 分支，此坑只能靠 Windows 本机跑测试暴露。

**Avoid**: 跨 WSL 边界的 argv 只传**无元字符的文件路径**：wrapper 落成宿主侧脚本文件（0600 独占创建，路径入清单随清理），argv 只剩 `bash /mnt/<drive>/…/wrapper.sh`，`"$?"` 全程不离开文件。

**Recovery**: 已写 0 的 status 无法复原，bg_kill 后重跑；旧清单无 wrapperPath 字段，升级后首个会话领养不清理残留 wrapper（无害，tmp 清理兜底）。

### P7: detached on_pattern 首询前写入的输出被惰性 offset 永久吞掉

**Trap**: 自有 detached 任务的文件 offset 惰性初始化——首个轮询 tick 才定位到当时文件末尾；起跑后 ≤ adoptPollMs（默认 2s，含 WSL 桥启动）内写入的行从不进入 LineMatcher。「启动即打第一条 milestone」的 runner 表现为 pattern 整场不响、清单 fired 恒 false，酷似轮询泵没挂上（泵其实一直在跑）。

**Why**: 泵只保证「从现在起」的增量；领养路径有全量回放、自有路径没有，起点没人钉在 0。

**Avoid**: 自有 detached 任务构造时 `fileOffsets = {stdout: 0, stderr: 0}`（POSIX 文件本就独占建空、win32 由子进程后建），首询前的字节照喂 matcher。

**Recovery**: `bg_status` 见 `matched×0` 且 stdout 明明有命中行即中招；重开会话走领养回放可补发一次陈旧唤醒。

### P8: Windows 上 detached 必弹控制台，Node kill 杀不穿 WSL 树

**Trap**: 两个独立坑同源（Windows 无信号/进程组语义）：① `spawn("bash", …, { detached: true, windowsHide: true })` 仍弹窗——detached 映射 DETACHED_PROCESS，windowsHide 映射 CREATE_NO_WINDOW，**组合时 DETACHED_PROCESS 占优**，中继 bash.exe 照拿可见自有控制台；② `bg_kill` 报「Sent SIGTERM」但 WSL 侧还活着——Node 的 kill 只 TerminateProcess 直接子进程，`kill(-pid)` 在 win32 直接报错被吞，WSL 整棵树孤儿存活。

**Why**: 两个 console 标志的组合优先级不受 Node 文档约束，实测以 DETACHED_PROCESS 为准；POSIX 进程组在 Windows 没有对应物。

**Avoid**: ① 弹窗：detached 控制台链必须经 **GUI 子系统启动器**中转（wscript.exe + `Run cmd, 0, True`——GUI 进程无控制台可弹，且免疫「关终端杀树」，宿主终端关闭不再波及任务）；② 杀树：`taskkill /pid <pid> /t /f`（/f 即 TerminateProcess，与 Node kill 同强度，无优雅退路可守）。

**Recovery**: 已弹窗口属旧任务，结束或 `taskkill /t` 后消失；杀不死的任务手工 `taskkill /pid <pid> /t /f`。

### P9: 长空窗后补发的心跳报告制造「任务刚起」错觉（elapsed 计时本身是对的）

**Trap**: 宿主睡眠/长空窗期间全部冻结，醒来后 catch-up 心跳一次性抵达：`still running (34103.7s elapsed)` 配着 tail 开头的 `armed 12:37`——session13 的 agent 与用户先后把 tail 的新近感当任务年龄，误报「刚起 13 分钟显示 9.5h，elapsed 坏了」，该误报还一度被立条成「WSL 时钟倾斜」根因。

**Why**: 事后对账（session13 转录全量 312 个事件 × spawn 时间戳）：296 个漂移 <1s；唯一「9.5h 异常」实为 9.47h 宿主睡眠空窗（12:37→22:05），notify 抵达时刻 − spawn = 34103.8s，与声称 elapsed 差 **+0.1s**——计时精确，错在把「报告到达」锚定成「任务起点」；tail 是最旧输出不是最新状态。

**Avoid**: 判读 elapsed 异常先对账 notify 行时间戳 − 任务 spawn 时间戳；notify 行时间是投递时间，忙/闲会话下晚于事件时间（实测投递滞后最多 ~8 分钟）；别用 tail 推断任务年龄。

**Recovery**: 据误报写下的根因要显式撤回重写（本条即首版自纠的留档）；基于「计时坏了」做出的决策（杀任务/重启守望）回溯复核。
