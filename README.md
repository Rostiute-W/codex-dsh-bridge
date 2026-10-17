# Codex DSH Bridge 0.1.9

Codex 规划并通过 MCP 提交任务，DeepSeek Harness 在桌面原生聊天中执行。你可以直接在该聊天里查看过程、补充要求、引导方向、选择模型和处理权限。Bridge 保留任务摘要、独立 Git 工作区、验收结果和审查记录；新任务不在 Bridge 中复制聊天窗口。

## 安装与升级

1. 完整退出 Bridge 和 DSH（从托盘退出），运行 `Codex DSH Bridge Setup 0.1.9.exe`。本机继续安装到 `E:\Codex DSH Bridge`，原有 MCP 路径不需要变化。用户任务数据保留。
2. 打开 Bridge 的“Codex 接入”，点击“安装 DSH 对话连接”。官方 CLI 将附带插件安装到当前 DSH 数据目录的 desktop profile。此时 DSH 必须完整退出；不会自动禁用其他插件或授予版本豁免。安装动作可以重复点击：连接文件、profile 依赖链接和 bundle 声明都已就绪时返回“无需重复安装”，缺少 bundle 声明或文件被改坏时才重新安装。
3. 点击“检查接入 / 安装 Skill”。相同 MCP 配置可以重复核对。升级时只自动备份并更新已知原版 Skill；用户修改过的 Skill 保持保护。重载 Codex MCP 或重新打开 Codex。
4. 安装完连接插件后，仍需你从托盘退出 DSH 再重新打开，插件才会加载。0.1.8 没有实现自动重启：Bridge 不结束 DSH 进程、不代按退出确认，也不等待重启后的连接，因此这一步不算自动完成，也不能算重启验收通过。
5. 打开 DSH，完成供应商与权限设置。在 Bridge“运行设置”点击“读取 / 刷新 DSH 模型”，选择供应商、模型／路由和推理强度，再保存。留在“跟随 DSH 默认”时保留原行为。
6. 在目标干净 Git 项目中通过 `$codex-dsh-bridge` 委派任务。DSH 会自动新建并打开普通聊天；也可以在 Bridge 点击“打开 DSH 对话”。若 DSH 未运行，Bridge 尝试启动安装包的桌面程序；连接插件不可用时保留现场，不自动切换执行方式。

旧插件包名沿用 `@codex-dsh/desktop-observer`，升级后用途变为原生聊天连接，原来的独立只读观察面板不再注册。旧 ACP 任务的记录、工作区和恢复方式保留。设置中的 ACP 模式用于兼容旧流程，新任务默认原生聊天。

0.1.9 把默认单次执行时限由 30 分钟改为 300 分钟，校验范围同步放宽到 1–300。升级后首次启动时，仍是旧默认 30 的设置一次性升级为 300，其他自定义值保持原样；迁移前会把原 `settings.json` 备份到数据目录的 `backups` 子目录。迁移后你自己把时限改回 30 也会被保留。

0.1.8 是一次不加功能的整理版，只包含本轮已审查合入的改动：

- 运行设置精简。只保留模型目录读取、供应商、模型／路由、推理强度和 DSH 路径等原生模式需要项；旧的 ACP 模型、Codex 执行文件、API 模型与 API Key 输入已不再显示，保存后在设置文件中兼容保留。
- 图标同源。窗口、托盘、页面品牌和安装包都用 `scripts/build-assets.cjs` 生成的同一份黑白灰 `icon.png`，不使用渐变、SVG 或外部图片。`assets` 不进入安装包，因此打包版 smoke 只校验 `dist/ui/icon.png` 存在、可被 `nativeImage` 加载且与页面品牌引用一致。
- 数据目录显示真实位置。设置页的“本地数据”用 `fs.realpath` 解析后再显示，C 盘的兼容 junction 会显示为它指向的真实目录。
- 安装幂等与恢复。重复点击“安装 DSH 对话连接”不会重复导出或重复调用插件安装；profile 缺少 bundle 声明或连接文件被改坏时会重新安装修复。安装结果明确说明不会自动退出、重启 DSH，也不会强制结束进程。

连接插件版本同步为 0.1.8。安装插件后仍要你自己从托盘退出 DSH 再打开，当前没有实现自动重启。

0.1.7 使用 DSH 官方 `sessionController.modelCatalog()` 读取当前桌面 Host 已加载配置的模型目录，支持 DeepSeek 账号、自定义 API 以及 Magpie 等自定义供应商。

0.1.6 保留每个任务详情的展开状态与文本滚动位置，修复定时刷新导致交接方案自动收起的问题。打开 DSH 对话与执行任务共用连接准备逻辑：DSH 未启动时尝试启动并等待连接，失败时提供中文操作提示。连接插件 0.1.6 在管道辅助进程异常退出后自动重建管道，保留原控制器、会话与提交保护；打开对话及重建管道不重发任务提示词。

0.1.5 修复原生消息发送时遗漏 DSH 公共接口必需 AbortSignal 的问题，同时按官方事件结构解析完成原因与助手回复，修复成功被误报失败和摘要为空的问题。连接插件同步升级至 0.1.5；失败提示包含脱敏的操作名和已知错误码。官方 Host 资格测试现已覆盖消息受理和重复请求，隔离测试禁止调用模型。0.1.4 的按钮 IPC 白名单修复继续保留。

关闭 Bridge 窗口后继续在托盘运行，明确退出会提示取消运行任务并保存现场。不默认开机自启。原生会话由 DSH Host 持有唯一写者，Bridge 不再启动另一个 ACP 进程抢占该会话。

## 任务、引导与审查

正常协作时，Codex 提交任务后调用 `wait_task`，通常静默等待工具结果，再进行审查。单次工具等待最多十分钟，超时返回当前状态；此时继续用同一个 `taskId` 等待即可，不要重复 `submit_task`，否则会产生新的任务。这与默认三百分钟的执行超时不同，等待机制本身只监听任务状态，不调用模型。若聊天已经结束或 Codex 暂时不能继续，DSH 可继续执行，Bridge 保留结果为等待审查，后续按任务 ID 接续，不会自动唤醒任意 Codex 聊天。

交接必须包含目标、方案、完整基准 commit、允许修改的路径、限制、验收条件和可信 PowerShell 验证命令。项目需已有 Git 基准且工作区干净，已有用户修改不会被自动暂存或丢弃。

Bridge 创建 `agent/dsh-…` 分支和独立 worktree，DSH 聊天的工作目录就是该 worktree，官方接口支持直接传入 cwd 创建会话，无需手动再次选择工作区。原生模式使用 DSH 桌面的模型、工具和权限设置，读取适用的全局及项目 AGENTS.md。请在 DSH 中处理权限；Bridge 负责核对变更范围和 Git 状态。原生权限按 DSH 自己的配置执行。

你在 DSH 发出的引导或后续消息由同一 Host 接收。Bridge 等待聊天空闲、队列清空和正常回合完成，然后运行验收。若聊天在验证或审查期间继续，即使文件尚未改变，旧审查也会失效。完成引导后可点击“重新验证”，或由 Codex 调用 `submit_task` 的 `operation: revalidate`，再审查新结果。

最近的用户引导经脱敏后随任务结果返回 Codex。用户已经引导过的任务若验收失败，Bridge 停止自动返工，交由 Codex判断验收条件与新方向是否冲突，避免自动修复抵消你的要求。

审查批准后，Host 在短暂提交步骤内拒绝新的 agent step，Bridge 核对指纹并显式暂存任务文件后创建本地 commit，随后释放保护。保护最长五分钟，异常断开后不会永久锁住聊天。提交完成后继续聊天属于新的工作，原报告和 Git 状态记录的是提交时的结果。

任务不自动推送、发布或合并原始 checkout。自动返工最多两轮，默认单次三百分钟；取消和中断保留现场。重启后不自动重发状态不确定的 prompt，明确恢复仍使用已记录的普通会话和官方 requestId 去重。

验证命令是 Codex 明确交接的可信本地命令，在 worktree 中以独立环境执行。目录范围检查不能替代对验收脚本的信任。

## 可选的 Trellis 任务上下文

交接可以带上项目里已有的 Trellis 任务目录，让 DSH 同时看到该任务的 PRD 与被引用的规范。适配 Trellis 0.6.17 的布局 `.trellis/tasks/<name>`；Bridge 只读其中的 Markdown 与 JSON，不需要安装或调用 Trellis 的全局 npm 包，也不把它作为运行时依赖。不带这个字段时行为与以前一致，完全不读 Trellis 文件。

只需在交接里增加一个字段：

```json
"trellis": { "taskPath": ".trellis/tasks/example" }
```

这是 `handoff` 中的片段，不是完整的 `submit_task` 示例。`taskPath` 使用仓库相对路径和正斜杠；绝对路径、上级路径、`.git`、盘符与 Windows 数据流一律拒绝。

仓库需要有干净的 Git 基准，且基准中已经提交任务目录的 `task.json` 与 `prd.md`，以及清单引用到的规范文件。规范从基准 worktree 读取：任务目录可选 `design.md`、`implement.md`；`implement.jsonl` 与 `check.jsonl` 每行一个 `{"file": "…", "reason": "…"}` 对象，`type` 省略时按单文件处理，写 `"directory"` 则只展开该目录本层、按名称排序的 Markdown，不递归。每个文件带 role 说明它被读的原因：`implementation` 来自 `implement.jsonl`，`review` 来自 `check.jsonl`，`shared` 是 `task.json`、`prd.md` 这类任务本身；同一文件被多处引用时合并 role，只读一次。

上限和失败方式都是明确的：最多 64 个文件、单文件 64 KiB、总计 128 KiB，超出直接报错停止，绝不截断。经过符号链接或目录联接、越出 worktree、命中 `.env`、密钥或证书一类文件、以及 `.runtime` 的引用同样被拒绝；资料中出现明显凭据时任务在发送前停止。

Bridge 在首次发送前读取一次，写成 Bridge 数据目录中的固定快照；任务详情只展示路径、基准、摘要、快照位置、各文件来源与 role，不展示正文。自动返工、重新验证、恢复与后续发送都复用这份快照，不会重新读取可能已被改动的项目文件；快照缺失、损坏或与任务记录不一致时停止并报错，不悄悄重建。需求或规范变了就要新建任务：新的 requestId 和新的基准提交。

Codex 审查必须以结果中的 `trellis.snapshotPath` 固定内容与文件摘要为依据，`handoff` 只说明引用了哪个任务目录。不要只读当前 worktree 里可能已被改动的规范；固定内容与 `handoff` 或验收条件冲突时报告冲突，并按 `handoff` 为准。

Trellis 在这里只提供参考。Bridge 仍然负责执行、验收、审批与 Git 提交，不调用 Trellis 的 `start`／`finish`／`archive`，不初始化项目或任务，不同步它的 journal，也不增设第二套验收。

这是源码功能，当前 0.1.9 安装包未因此升级。

## 中文与历史数据

0.1.3 修复了 Windows 管道辅助程序使用本机代码页输出 JSON 导致的中文损坏，管道全程使用 UTF-8，并正确处理跨数据包的多字节字符。PowerShell 验证输出显式使用 UTF-8，关闭进度 CLIXML。

旧版已经损坏的字符无法从替换字符反推原文。任务列表用任务 ID 标识受损标题，保留原始审计记录；新交接的中文与 emoji 由实际管道回归检查。

## 模型与数据目录

0.1.7 使用 DSH 官方 `sessionController.modelCatalog()` 读取当前桌面 Host 已加载配置的模型目录，支持 DeepSeek 账号、自定义 API 以及 Magpie 等自定义供应商。供应商和模型保持其真实 ID，例如 `magpie / group/cheap-first`，名称“便宜优先-主用deepseek”；路由后的具体模型由 Magpie 自己决定。Bridge 不接收、复制或保存这些供应商的 Key，不直接解析或输出完整 DSH 配置。模型列表仅在手动读取时刷新；DSH 未启动时会尝试启动。切换数据目录后须让 DSH 使用相同目录再读取。

选择模型时，支持 `max` 则优先选择 `max`，否则使用该模型声明的默认档位。已保存的档位保持原值。部分供应商读取失败时仍展示其他可用供应商；已选模型消失会保留原 ID 并提示不可用，保存和首次应用时拒绝无效模型或档位，不静默退回其他模型。旧连接插件需升级到 0.1.8 并完整重启 DSH。

每个新任务持久化其初始模型选择，排队后修改设置不会改变它。首次发送前通过官方 `sessionController.selectModel()` 应用选择，按 DSH 官方行为也会更新其默认模型；设置页保存本身只更新 Bridge。恢复、重发和返工通过持久化会话事件判断是否已选择或已发送消息，保留你在 DSH 中后续手动选择的模型。任务详情中的“初始模型”用于追溯，实时状态以 DSH 对话为准。既有任务不自动迁移模型。

原生模式不使用旧版 ACP 模型选项 ID。该值仍在设置文件里兼容保留，但运行设置不再显示旧 ACP 模型、Codex 执行文件、API 模型与 API Key 输入；`["deepseek-account","deepseek-flash"]` 之类的旧值可通过 `npm run doctor:acp` 查询。新模型下拉框只控制原生模式。

DSH 数据目录对应 `DSH_HOME`，通常是 `~/.dsh`，保存 DSH 配置、凭据和会话。全局指令为 `$DSH_HOME/AGENTS.md`。Bridge 数据保存在 `%LOCALAPPDATA%\CodexDshBridge`，包括任务状态、worktree、diff、验证报告与设置；升级保留数据。本机数据实际位于 `D:\dsh_bridgesession\CodexDshBridge`，C 盘路径是指向该目录的兼容 junction：读写仍走原路径，设置页显示的“本地数据”是由 `fs.realpath` 解析出的真实位置。

## 审查与图标

审查报告由 Codex 通过 `submit_task` 的 `review` 操作回传，任务详情中照常显示历史报告，包括早期由独立 API 生成的报告与用量记录。Bridge 界面不再提供独立付费审查入口，也不再接收或保存 OpenAI API Key。

窗口、托盘、页面品牌与安装包图标使用同一份 `icon.png`：`#fafafa` 圆角方底、`#171717` 桥形轮廓，中间拱居中、两端各一桥墩，只有黑、白、灰像素。图标由 `scripts/build-assets.cjs` 生成，`assets/icon.ico` 内嵌同一份 PNG。`assets` 不进入安装包，因此 smoke 校验按运行形态分流：源码模式比对 `assets/icon.png`、`assets/icon.ico` 与 `dist/ui/icon.png` 同源，打包模式只校验 `dist/ui/icon.png` 存在、可被 `nativeImage` 加载且与页面品牌引用一致。

## 开发与验证

需要 Windows、Node.js 24、Git 与系统 .NET Framework 4.x 编译器。安装包附带 Electron 运行时与管道辅助程序；本机仍需 DSH、Codex、Git 和验收工具。

```powershell
npm ci
npm run typecheck
npm test
npm run smoke
node scripts/qualify-dsh-observer.mjs
npm run package
```

默认测试使用模拟模型和真实临时 Git 仓库。官方 Host 验证脚本使用隔离 Web profile，验证普通会话创建、客户端插件 boot graph、认证、命名管道及聊天打开请求，不发送模型 prompt。它不能替代安装后的 Windows 原生 UI 和真实模型任务验收。

MCP 接口为 `submit_task`（execute / review / revise / resume / revalidate）、`wait_task`、`get_task_result`、`cancel_task`。初始 requestId 重试必须保持相同交接；审查携带当前 fingerprint。审查只由 Codex 回传，Bridge 不自行调用模型。

原生连接使用 DSH 官方 `ctx.sessionController` 和 `ctx.uiWorkspace.openSession`。控制命令经过当前 Windows 用户专用命名管道；客户端打开请求使用 DSH 自带的认证路由。Bridge 不提供浏览器状态页或 HTTP 服务。仅支持 Windows 本地项目、串行执行；安装包尚未商业签名。

官方接口：[Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)、[原生会话布局](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md)、[插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)。
