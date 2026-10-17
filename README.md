# Codex DSH Bridge 0.2.1

Codex 负责规划与审查，DeepSeek Harness（下称 DSH）负责在桌面原生对话中执行，Bridge 负责创建隔离工作区、运行验收、收集证据并完成本地提交。整个过程只有一条链路：Codex 通过 MCP 提交交接方案，DSH 在原生聊天里干活，Bridge 核对结果，最后仍由 Codex 审查、由 Bridge 落本地 commit。不推送、不发布、不合并。

0.2.1 是首个包含 Trellis 任务上下文的发布版本：交接可以附带项目里已有的 Trellis 任务目录，让执行者与审查者都基于同一份固定快照工作。安装包作为 GitHub Release 附件提供，源码树里不含 exe。

## 适用范围与依赖

- Windows x64。目前只支持本地项目与串行执行，不提供浏览器状态页或 HTTP 服务。
- 需要已安装的 DSH 桌面版、Codex CLI，以及可以正常运行 Node.js 工具链的 Git。
- 源码开发需要 Node.js 24、Git，以及系统自带的 .NET Framework 4.x 编译器（用于编译管道辅助程序）。

## 安装

1. 完整退出 Bridge 与 DSH。两者都在托盘常驻，右键托盘图标选择退出，不要只关窗口。
2. 运行发布附件中的 `Codex DSH Bridge Setup 0.2.1.exe`。安装目录可以自选；如果此前装在别处（例如已有的 `E:` 盘目录），装到同一目录即可，已有的 MCP 配置路径不需要改。
3. 打开 Bridge，进入“Codex 接入”，点击“安装 DSH 对话连接”。这一步调用 DSH 官方 CLI，把随包附带的连接插件装到当前 DSH 数据目录的 desktop profile。安装前 DSH 必须处于完全退出状态；Bridge 不会替你禁用其他插件，也不会给插件加版本豁免。这个按钮可以重复点击：连接文件、profile 依赖链接和 bundle 声明都已就绪时返回“无需重复安装”，文件被改坏或缺少 bundle 声明时会重新安装修复。
4. 仍在“Codex 接入”，点击“检查接入 / 安装 Skill”。这一步注册 MCP 并安装 Skill；相同配置可重复核对，不会重复写入。
5. 从托盘完整退出 DSH，再重新打开。连接插件只有在 DSH 重启后才会加载；Bridge 不会结束 DSH 进程、不会代按退出确认，也不会等待重启结果，因此这一步必须由你完成。
6. 重载 Codex 的 MCP（或直接重开 Codex 聊天）。0.2.1 的交接结构新增了 `trellis` 字段，旧会话缓存的工具定义里没有它，必须重载后才能提交带 Trellis 的任务。
7. 在 DSH 里完成供应商、模型与权限设置；回到 Bridge 的“运行设置”，点击“读取 / 刷新 DSH 模型”，选择供应商、模型／路由与推理强度后保存。保持“跟随 DSH 默认”则沿用 DSH 自己的选择。

安装和升级都不会删除已有数据：用户任务、工作区、审查记录和设置都保留在 Bridge 数据目录中，DSH 的配置、凭据与会话保留在 DSH 数据目录中。

### 从 0.1.9 升级

1. 从托盘退出 Bridge，再从托盘退出 DSH。
2. 运行 0.2.1 安装程序，安装到原来的目录，数据目录不变，原 MCP 配置继续有效。
3. 按上一节第 3 步重新安装 DSH 对话连接，让连接插件升级到 0.2.1。
4. 按上一节第 4 步“检查接入 / 安装 Skill”。已识别的 0.1.9 原版，以及一个已核对的更早原版，可以自动先备份再更新；其他内容不同的 Skill（包括你改过的）保持原样并提示你备份或处理。指向其他位置的符号链接、以及带多个硬链接的文件同样会被拒绝。
5. 在 Codex 中重载 MCP，然后从托盘重启 DSH。
6. 旧 ACP 任务的记录、工作区和恢复方式都保留；旧版设置中的 ACP 相关字段在设置文件里兼容保留，界面不再显示。
7. 0.1.9 的默认执行时限已是 300 分钟，升级不会改动你当前的时限设置。

## 协作流程

正常一轮是这样的：

1. Codex 规划任务，组装交接方案：目标、方案、基准 commit、允许修改的路径、限制、验收条件、可信的 PowerShell 验证命令。
2. Codex 通过 `submit_task` 提交，然后调用 `wait_task` 等待。等待本身不调用模型，单次最多十分钟；超时后用同一个 `taskId` 继续等待，不要换 `requestId` 重新提交，以免多出一个重复任务。
3. Bridge 从基准 commit 新建 `agent/dsh-…` 分支和独立 worktree，DSH 原生聊天的工作目录就是这个 worktree。执行者可以直接看到项目里适用的 AGENTS.md。
4. 检查按交接分工：执行者只跑交接里要求它自查的部分，交接中给出的验收命令由 Bridge 统一跑一次，生成检查记录、变更文件列表和指纹；同一套命令不需要两边各跑一遍。
5. 你在 DSH 聊天里看到的执行过程就是真实过程：可以补充要求、纠正方向、自己处理权限请求。模型选择与权限策略由 DSH 决定，Bridge 不代管。
6. Codex 用 `get_task_result` 取回证据，审查实际代码；通过则用 `submit_task` 的 `review` 操作回传结论，Bridge 核对指纹、显式暂存任务文件并创建本地提交。审查不通过则回传具体问题，Bridge 进入返工流程。

你可以在任务进行中随时在 DSH 里插话。执行期间的引导会随本轮对话收集，并在本轮结束后正常验收，不需要额外操作。只有在验证或审查期间对话又继续（Bridge 验收时对话仍在跑，或已经验收完、正在等 Codex 审查时你又发了消息），旧的验收证据和审查才会失效——这时等对话完成后再重新验证一次（任务详情里的“重新验证”，或由 Codex 调用 `submit_task` 的 `operation: revalidate`），然后审查新结果。

自动返工最多两轮：验收失败会自动带着失败信息再执行一次，最多两次。如果这期间你在 DSH 里给过引导，Bridge 会停下自动返工，把引导一起交给 Codex，由它判断验收条件与新方向是否冲突。单次执行时限默认 300 分钟（可设 1–300）。取消与中断都保留现场。

审查通过后的提交阶段，Bridge 会短暂拒绝新的执行步骤、核对指纹、显式暂存任务文件后提交，然后释放保护；保护最长五分钟，异常断开不会永久锁住聊天。提交之后的继续聊天属于新的工作，原报告记录的是提交那一刻的结果。

## 可选的 Trellis 任务上下文

交接可以附带项目里已有的 Trellis 任务目录，让执行者与审查者同时看到该任务的 PRD 和被引用的规范。适配 Trellis 0.6.17 的布局 `.trellis/tasks/<name>`；归档任务用完整仓库相对路径 `.trellis/tasks/archive/<yyyy-mm>/<name>`。Bridge 只读其中的 Markdown 与 JSON，不需要安装 Trellis 的全局 npm 包，也不把它作为运行时依赖。不带这个字段时行为与以前完全一致，完全不读 Trellis 文件。

只要在交接里多一个字段：

```json
"trellis": { "taskPath": ".trellis/tasks/example-task" }
```

这是 `handoff` 中的片段，不是完整的 `submit_task` 参数。`taskPath` 必须使用仓库相对路径和正斜杠；绝对路径、上级路径、`.git`、盘符和 Windows 数据流一律拒绝。

前提是仓库有一个干净的 Git 基准，且基准中已经提交了任务目录的 `task.json` 与 `prd.md`，以及清单引用到的规范文件。上下文从基准 worktree 读取：任务目录可选 `design.md`、`implement.md`；`implement.jsonl` 与 `check.jsonl` 每行一个 `{"file": "…", "reason": "…"}` 对象，省略 `type` 按单文件处理，写 `"directory"` 则只展开该目录本层、按名称排序的 Markdown，不递归。

每个文件带 role 说明它为什么被读取：`implementation` 来自 `implement.jsonl`，`review` 来自 `check.jsonl`，`shared` 是 `task.json`、`prd.md` 这类任务本身。同一文件被多处引用时合并 role，只读一次。

上限是硬性的：最多 64 个文件、单文件 64 KiB、总计 128 KiB；超出直接报错停止，绝不截断。经过符号链接或目录联接、越出 worktree、命中 `.env`、密钥、证书一类文件、以及 `.runtime` 的引用同样被拒绝。资料中出现明显凭据时，任务在发送前就停下。

Bridge 在首次发送前读取一次，写成 Bridge 数据目录里的固定快照；任务详情只显示路径、基准、摘要、快照位置、各文件来源与 role，不显示正文。自动返工、重新验证、恢复和后续发送都复用这份快照，不会重读可能已被改动的项目文件；快照缺失、损坏或与任务记录不一致时停止报错，不悄悄重建。需求或规范变了，就新建任务：新的 `requestId` 和新的基准提交。

Codex 审查必须以结果里的 `trellis.snapshotPath` 固定内容与文件摘要为依据，`handoff` 只说明引用了哪个任务目录。不要只读当前 worktree 里可能已经被改过的规范；固定内容与 `handoff` 或验收条件冲突时报告冲突，并以 `handoff` 为准。

Trellis 在这里只提供参考：Bridge 仍然负责执行、验收、审批与 Git 提交，不调用 Trellis 的 `start`／`finish`／`archive`，不初始化项目或任务，不同步它的 journal，也不增设第二套验收。上下文不会推进 Trellis 的生命周期。

完整的 `submit_task` 参数示例（保留原有字段，只在末尾加上 `trellis`）：

```json
{
  "operation": "execute",
  "handoff": {
    "requestId": "example-settings-diagnostics-001",
    "title": "示例：为设置页增加只读诊断",
    "repoPath": "D:\\projects\\example-app",
    "baseCommit": "0123456789abcdef0123456789abcdef01234567",
    "ready": true,
    "goal": "在设置页增加只读诊断区，显示当前数据目录与最近一次验收时间。",
    "plan": "1. 在设置页新增只读诊断区块……",
    "constraints": ["仅改设置页与其样式", "不新增依赖"],
    "allowedPaths": ["src/ui/app.js", "src/ui/style.css"],
    "validationCommands": ["npm run typecheck"],
    "acceptanceCriteria": ["诊断区只读且不触发写入"],
    "commitMessage": "feat: add read-only settings diagnostics",
    "trellis": { "taskPath": ".trellis/tasks/example-task" }
  }
}
```

## MCP 接口

Bridge 只暴露四个工具，全部围绕同一个任务 ID：

| 工具 | 作用 |
| --- | --- |
| `submit_task` | `execute` 提交新交接；`review` 回传审查；`revise` 按审查意见返工；`resume` 明确恢复；`revalidate` 在用户引导后重新验收 |
| `wait_task` | 等待任务落定或权限请求，最多十分钟，不调用模型；超时用同一 `taskId` 继续等 |
| `get_task_result` | 读取状态、精确 worktree 与指纹、验收证据、审查结论和本地提交；可在后续 Codex 聊天中取回结果 |
| `cancel_task` | 取消执行并保留全部文件，不丢弃修改、不删除任务工作区 |

`requestId` 幂等：同一 `requestId` 重试必须携带完全相同的交接。审查必须携带当前指纹，指纹不符会被拒绝。审查只由 Codex 回传，Bridge 不自行调用模型。

Bridge 不会自动推送、发布或合并原始 checkout，也不会改写历史。你的本地修改不会被自动暂存或丢弃；提交时只暂存任务允许范围内的文件。

## 数据与凭据

- Bridge 数据默认在 `%LOCALAPPDATA%\CodexDshBridge`，包含任务状态、worktree、diff、验收报告、Trellis 快照与设置。路径在设置页按真实位置显示（`fs.realpath` 解析后）。升级不会清空。
- DSH 数据对应 `DSH_HOME`，通常是 `~/.dsh`，保存 DSH 的配置、凭据与会话；全局指令为 `$DSH_HOME/AGENTS.md`。
- Bridge 不接收、不复制、不保存任何供应商 Key，也不解析或输出完整 DSH 配置。日志与错误信息在返回前做脱敏；本仓库的文档与代码不包含账号、邮箱或真实任务日志。

## 开发

按用途选择命令，不必每次都全跑：

```powershell
npm ci          # 首次安装依赖
npm run build   # 编译 TypeScript 并生成图标、管道辅助程序
npm run typecheck
npm test        # 构建后运行全部单元与集成测试（模拟模型、真实临时 Git 仓库）
npm run smoke   # 启动 Bridge 的自检流程
node scripts/qualify-dsh-observer.mjs   # 官方 Host 资格验证
npm run package # 生成 Windows x64 NSIS 安装包到 release/
```

- 只改文档或版本号时，`npm run typecheck` 足够；改到构建产物或安装流程再跑 `npm test` 或 `npm run smoke`。
- 日常开发用 `npm start`（构建后直接以 Electron 启动）。
- `scripts/qualify-dsh-observer.mjs` 使用隔离的 Web profile 验证会话创建、客户端插件 boot graph、认证、命名管道与打开聊天请求，不发送模型 prompt；它不能替代安装后的原生 UI 与真实模型任务验收。
- `npm run doctor:acp` 可查询旧 ACP 兼容设置的状态，仅供排查历史配置。

## 0.2.1 更新要点

- 交接新增可选 `trellis` 字段：把 Trellis 任务目录的 PRD、设计与规范以固定快照交给执行者和审查者，超出上限、经过链接或包含凭据的资料直接报错停止。
- 任务详情显示 Trellis 上下文摘要（路径、基准、摘要、快照位置、各文件 role），正文不出现在界面里。
- 旧版原版 Skill 允许在自动备份后升级：识别到 0.1.9 原版和一个已核对的更早原版时自动备份再更新；其他内容不同的 Skill（含用户改动）与指向链接的文件仍然拒绝覆盖。
- 版本统一为 0.2.1：应用、锁文件根版本与连接插件保持一致。

已验证范围仅限真实 DSH 小任务：一次原生对话交接、Trellis 快照注入、验收与审查回传、本地提交。界面的完整交互细节与安装包升级流程尚未作为已验证项，请以实际使用为准。

## 已知限制

- 仅 Windows x64、本地项目、串行执行；一次只跑一个任务。
- 安装包未做商业代码签名。
- 旧版已经损坏的文本无法从替换字符反推原文；任务列表用任务 ID 标识受损标题，旧审计记录保留。
- 连接插件安装完成后必须由你手动退出并重启 DSH；Bridge 不做自动重启。
- DSH 的模型与权限行为以其自身配置为准，Bridge 只核对变更范围与 Git 状态。

## 许可

MIT，见 [LICENSE](LICENSE)。

官方接口参考：[Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)、[原生会话布局](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md)、[插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)。
