# 第一版及 0.1.7 验证记录

验证日期：2026-10-03。系统：Windows x64，Node.js 24.15.0，Electron 44.5.1，本机 DSH 0.2.0-rc.2，Codex CLI 0.159.2。

## 0.1.7 原生模型与自定义路由选择

验证日期：2026-10-17。

新增供应商、模型／路由、推理强度选择，目录来自官方桌面 Host 的 modelCatalog，只投影元数据；供应商错误统一为通用提示，不回传原始错误或凭据。新任务持久化独立模型快照，首次发送前 selectModel；已存在模型选择或消息的会话不重复应用设置，保留用户后续切换。兼容旧设置、旧任务与 ACP 模型输入。

`npm run typecheck`、`npm run build` 通过；`node --test dist/tests/native.test.js dist/tests/observer.test.js` 21 项通过，覆盖自定义 Magpie 元数据、秘密排除、不可用模型／非法强度／应用失败不发送 prompt、准备重试、控制器重建与人工切换保护、模型快照及旧配置、旧插件和错误数据目录。

`node scripts/qualify-dsh-observer.mjs` 通过。隔离 DSH_HOME 的官方 Host 实际加载虚拟 Magpie 配置，modelCatalog 返回“便宜优先-主用deepseek”，selectModel 应用 group/cheap-first 与 max，并核对官方默认选择同步；重复 prepare 未追加事件。生成 gate 拒绝模型步骤，未调用真实模型或复制用户凭据。

开发版和最终打包版 Electron smoke 均已通过真实 DOM、受限 preload 和 IPC 读取自定义模型、默认选择 max、保存设置、保留失效路由、拒绝失效设置，以及保存“跟随 DSH 默认”；同时通过此前展开状态、托盘和单实例等检查。已查看最终打包版设置截图，中文和下拉框显示正常。

`node --test dist/tests/bridge.test.js` 核心回归 21 项通过，1 项打包测试按默认配置跳过；设置 `BRIDGE_PACKAGED_EXECUTABLE` 后单独运行 `node --test --test-name-pattern='packaged Electron' dist/tests/bridge.test.js`，该项通过。`npm run package` 成功生成 0.1.7 安装包。交付时本机仍运行 0.1.6，等待从托盘退出 DSH 和 Bridge 后升级；安装情况见 delivery-manifest.json。尚未用新版本向真实 Magpie 路由发送编码 prompt。

## 0.1.6 详情展开与原生连接恢复

验证日期：2026-10-04。旧版真实 Electron smoke 通过点击“查看交接方案”并等待 1.7 秒复现自动收起。详情区每 1.5 秒重建 DOM，却未保存 details.open。按任务及区块保存展开状态和文本滚动位置后，实际点击、刷新后保持展开、保持滚动位置、手动收起后保持收起均通过。

本机 DSH 窗口与后台仍存在，插件端点匿名请求返回 401，插件范围内不存在的端点返回 404；desktop profile 依赖正确，Bridge 管道存在，但没有原生 desktop 管道辅助进程。原按钮直接发送 focus，未准备连接；插件在辅助进程退出后也未重建它。退出的具体外部原因未确认。

Windows 回归通过定位本测试进程创建的唯一隔离管道 helper，终止该 helper 后等待能力恢复：旧实现不能恢复，新实现通过。恢复后重复打开聊天没有创建会话或发送 prompt；释放插件后不再恢复管道。未修改用户进程或调用模型。缺失桌面安装和预先取消的调用给出中文提示，不暴露裸 ENOENT。

命令：npm run typecheck、npm run build、node --test dist/tests/native.test.js dist/tests/observer.test.js、npm run smoke、node scripts/qualify-dsh-observer.mjs。类型检查、16 项定向回归、真实 Electron smoke、官方隔离 Host 资格验证全部通过。打包版检查及本机冷启动核对记录在 delivery-manifest.json 中。

本机已安装 0.1.6 软件与 desktop 插件；安装 ASAR 与打包交付文件、安装 native.js 与源码的 SHA-256 一致。首次核对发现旧 DSH 进程仍运行，新启动回到旧实例，连接准备返回预期中文提示；用户从托盘退出后，原生管道缺失时 openDesktopChat 自动启动 DSH 并请求打开原会话。界面打开后 agent 异步附着，随后 inspect 返回原 sessionId、idle 和 cursor 42。重复打开未追加事件，完成任务记录与安装前备份一致，Bridge ping 返回 0.1.6。本轮没有发送新任务、调用模型或付费 API。

## 0.1.5 DSH 原生消息受理修复

验证日期：2026-10-04。保留原失败任务 b8bf90c0-e6e3-4cb4-b3c2-e7ea3bad78de；其 worktree 目录存在且 Git 干净。官方接口 sessionController.create 支持 cwd，无需人工选择 workspaceId。官方 Host 隔离复现证实错误为 TypeError: Cannot read properties of undefined (reading 'throwIfAborted')，DSH 公共 sessionController.prompt(request, signal) 要求第二参数；此前仅核对内部命令实现，遗漏公共接口的取消信号。

模拟 Host 按公共接口先执行 signal.throwIfAborted，旧实现同样失败；传入 AbortSignal 后原生测试 7 项全部通过。错误回传仅展示操作名和已知错误码，不包含异常原文、details 或凭据。原生测试包括重复消息、审查失效、用户引导、取消及提交。

官方隔离 Host 资格脚本已覆盖 prepare、send、同一 requestId 重发和 cancel。测试专用 agent/pre-step hook 拒绝生成，未调用真实模型、未复制凭据、未修改桌面 profile。全部资格项通过。

真实模型已在原会话修改 hello.txt 为“DSH 调用测试成功。”。续测发现另一个公开事件结构问题：turn/end.data.reason 为带 kind 的对象，assistant/message.data.message 才携带 content；旧解析导致完成误报和空摘要，现已同步修正，模拟 Host 也按官方结构生成事件（取消为 aborted/user）。真实任务恢复采用重新验证已有文件，不要求模型重复编辑。

全套默认测试 35 项通过、1 项打包检查默认跳过；单独打包 MCP 检查通过。打包桌面 smoke 通过，包括受限 IPC 安装按钮、原生聊天入口、托盘、单实例与 DPAPI。事件结构修正后再次运行 7 项原生回归和官方 Host 资格脚本，全部通过。

真实验收：原任务通过 MCP 的 revalidate 重新核对既有修改，只有 hello.txt 变化，PowerShell 独立验收 exit=0，输出“真实 DSH 文件编辑验收通过”。Codex 实际读取 diff、文件及原始 checkout 状态，并按精确 fingerprint 提交 approved 审查。Bridge 将任务置为 completed，生成本地提交 3e42b3ab9818231a76699faf8d57622e3f80f5b8（test: confirm real DSH desktop invocation）；worktree 和原始仓库均干净，原始文件仍为基准内容。未调用 OpenAI 付费审查。

## 0.1.4 DSH 操作的 IPC 白名单修复

验证日期：2026-10-04。本机已安装 0.1.3，按钮调用的 `installDshObserver` 与主进程处理器一致，但 preload 安全白名单遗漏它；`openDshChat` 也有相同遗漏。真实 preload 的最小回归先返回“未知操作”而失败，补齐这两个操作后通过；任意未知操作仍被拒绝，没有放宽 IPC。

`npm run typecheck` 和 `npm run build` 通过。`node --test dist/tests/observer.test.js` 共 7 项通过，0 失败、0 跳过。本轮修复集中于 preload 与 smoke 检查，未重复执行上一版整套编码／审查回归。

开发版 smoke 已实际点击安装按钮，经受限 preload 和主进程调用隔离模拟 CLI，校验 `plugin --profile desktop add` 参数以及导出的 native.js。打开 DSH 对话请求也通过 preload 到达隔离原生管道；管道刻意不存在，返回预期连接错误，而非“未知操作”。测试不会修改真实 DSH profile 或调用模型。上一版 smoke 只核对按钮显示与插件导出，没有覆盖这个按钮调用链，已补上该缺口。

最终 0.1.4 打包版 `--smoke-test` 也通过，`dshInstallButton`、`nativeChatFocusIpc`、托盘恢复、单实例、DPAPI 均通过。设置 `BRIDGE_PACKAGED_EXECUTABLE` 后运行 `node --test --test-name-pattern='packaged Electron' dist/tests/bridge.test.js`，1 项通过；`npm run package` 成功。

安装包：`release/Codex DSH Bridge Setup 0.1.4.exe`。SHA-256：`69E05F46FD72B46D3BCF1E435ED37B64866607D0EC8C69F21B0C7CF681CC2E88`。本轮未覆盖正在运行的用户安装版，需从托盘退出并升级到 0.1.4 后重新安装连接。

## 0.1.3 中文修复与原生 DSH 聊天

本轮验证日期：2026-10-04。中文损坏在真实 Windows 命名管道回归中复现：旧版 C# 辅助程序按本机代码页输出 JSON，Node 按 UTF-8 读取，导致中文变成替换字符、emoji 变成问号。修复 Console 编码后同一回归通过；另有跨 UTF-8 字符分包的回归，PowerShell 验收输出也显式使用 UTF-8。历史已损坏字符无法还原，保留审计记录。

新任务通过 DSH 官方 Session Controller 创建普通聊天，客户端通过官方 uiWorkspace 打开真实会话。没有独立 ACP 写者，也不注册旧观察面板。用户引导、权限与模型选择在 DSH 中处理；引导经脱敏回传 Codex，与验收冲突时停止自动返工。聊天继续即使未改文件也使旧审查失效，需重新验证；本地提交期间使用短暂 Host 保护。

默认测试使用模拟模型、真实临时 Git 仓库和 Windows 命名管道，覆盖普通会话及 prompt 去重、工作区范围、用户引导、审查失效与重新验证、取消保留现场、提交保护及原仓库不变。官方 Host 检查使用隔离 Web profile 和安装版 DSH runtime，实测普通会话创建、认证、客户端 boot graph、命名管道及聊天打开请求，不发送模型 prompt。

| 检查 | 命令／方式 | 结果 |
| --- | --- | --- |
| TypeScript | `npm run typecheck`、`npm run build` | 通过 |
| 整套回归 | 设置 `BRIDGE_PACKAGED_EXECUTABLE` 后执行 `npm test` | 33 项通过，0 失败、0 跳过 |
| 新增取消边界 | `node --test --test-name-pattern='cancellation while' dist/tests/native.test.js` | 1 项通过：保存新会话时取消，不发送 prompt |
| 补充引导的 API 审查 | `node --test --test-name-pattern='manual API review' dist/tests/bridge.test.js` | 1 项通过：真实子进程收到引导数据，认证隔离、脱敏和失败不重试；模拟 API，无实际费用 |
| 最终打包 MCP | `node --test --test-name-pattern='packaged Electron' dist/tests/bridge.test.js` | 1 项通过，最终 ASAR 与附带辅助程序可用 |
| 最终打包窗口 | `--smoke-test`，隔离数据目录 | 中文和 emoji、无聊天日志、任务详情、接入状态、重复安装、托盘、单实例、DPAPI 全部通过；截图已检查 |
| Skill 升级 | 隔离目录预置已知旧版 Skill 后执行打包 smoke | 先备份再更新；最终内容与新 Skill 一致，未改实际用户 Skill |
| 官方 DSH Host | `node scripts/qualify-dsh-observer.mjs` | 原生普通会话、认证、客户端 boot graph、管道及打开请求通过，无模型调用 |
| 官方 CLI 升级 | 隔离 Web profile 先安装 0.1.2，再安装 0.1.3 | 唯一依赖指向新版目录，实际解析版本为 0.1.3 |
| Skill 格式 | `quick_validate.py skill/codex-dsh-bridge` | 通过 |
| 生产依赖 | `npm audit --omit=dev --audit-level=high` | 0 个已知漏洞 |
| 最终打包 | `npm run package` | 0.1.3 NSIS x64 安装包生成成功，包含原生连接插件；尚未商业签名 |

最终安装包：`release/Codex DSH Bridge Setup 0.1.3.exe`。SHA-256：`E66970CD1A9157871E8C9A0D5AA04567A0CD00BA2D6A8E5DF9D499139E1F47A1`。

实际安装版仍是旧版本，用户的 Bridge 与 DSH 正在运行，本轮未强制关闭或覆盖。Windows 原生 DSH 窗口中的真实模型任务和手动付费 API 审查尚未实测，不能用隔离 Host 或模拟结果替代。升级步骤见 README；原有 E 盘 MCP 路径保持适用。

## 0.1.0 基线检查

| 检查 | 命令／方式 | 结果 |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | 通过 |
| 集成测试 | 设置 `BRIDGE_PACKAGED_EXECUTABLE` 后执行 `npm test` | 21 项通过，无跳过或失败 |
| 最终打包版 MCP | `node --test --test-name-pattern='packaged Electron' dist/tests/bridge.test.js` | 通过，Electron Node 模式从 app.asar 运行 MCP，使用附带的管道辅助程序 |
| 原生界面 | 开发版及打包版 `--smoke-test`，使用隔离数据目录 | 页面、受限 preload、关闭到托盘、恢复、重复启动、DPAPI、任务详情、日志纯文本显示均通过 |
| 真实 DSH 协议 | `npm run doctor:acp` | ACP v1；实际 profile 检查，新建、关闭及恢复会话通过；没有发送 prompt |
| Skill | `quick_validate.py skill/codex-dsh-bridge` | 通过 |
| 生产依赖 | `npm audit --omit=dev --audit-level=high` | 0 个已知漏洞 |
| 安装包 | `npm run package` | NSIS x64 安装包生成成功；未进行真实安装，也未签名 |

集成测试使用官方 ACP／MCP SDK、模拟模型服务和真实临时 Git 仓库。覆盖正常提交、新增文件 diff 和暂存指纹、已有用户修改、验收失败返工、审查意见修复、指纹失效、范围越界、权限处理与取消、进程中断及重启、异常 stop reason、付费请求去重、交接幂等、退出取消队列、Windows 进程时限和中文输出、管道断开、并发审批、Git hook 修改检测、独立 API 认证与脱敏、旧报告拒绝复用、MCP 工具及任务时限。

## 0.1.2 接入状态与 DSH 桌面观察

已复现并修复“已有 MCP 配置，界面仍显示等待接入”的问题。原生窗口回归先失败，再通过：配置注册状态独立于 MCP 活动时间；相同配置重复安装不会改写 config.toml；不同路径、禁用、超时不足和解析错误分别显示诊断。MCP 初始化会向桌面发握手，观察请求不会被计为 Codex 活动。

| 检查 | 命令／方式 | 结果 |
| --- | --- | --- |
| TypeScript | `npm run typecheck`、`npm run build` | 通过 |
| 整套默认测试 | 设置 `BRIDGE_PACKAGED_EXECUTABLE` 后执行 `npm test` | 26 项通过，无跳过或失败；随后补充尾部密钥脱敏及打包插件导出检查，定向回归通过 |
| 观察与接入回归 | `node --test dist/tests/observer.test.js` | 4 项通过；覆盖配置识别、文本脱敏、DSH loader／slot 注册、认证／GET 边界、管道数据更新与 Codex 活动区分 |
| 原生窗口 | 开发版与打包版 `--smoke-test` | 已注册状态、重复安装、插件导出、托盘、单实例、DPAPI、任务详情与文本日志通过 |
| 最终打包版 MCP | `node --test --test-name-pattern='packaged Electron' dist/tests/bridge.test.js` | 1 项通过；最终 0.1.2 ASAR 中的 MCP 与附带管道辅助程序正常通信 |
| 真实 DSH Host | `node scripts/qualify-dsh-observer.mjs` | 隔离 Web profile，使用安装版 DSH 0.2.0-rc.2；本地插件激活、实际客户端 boot graph、官方认证及实时管道数据读取通过 |
| 生产依赖 | `npm audit --omit=dev --audit-level=high` | 0 个已知漏洞 |
| 打包 | `npm run package` | 0.1.2 NSIS x64 安装包生成成功，包含观察插件；ASAR 导出使用逐文件读取，避免递归 cp 的虚拟目录问题 |

用户退出 DSH 后，已通过官方 CLI 在当前 desktop profile 安装 `@codex-dsh/desktop-observer`。配置与锁文件备份保存在 `%LOCALAPPDATA%\CodexDshBridge\backups\dsh-desktop-before-observer-20261003`。保留原有模型、登录和其他插件配置。DSH 提示已有 `dsh-better-sidebar@0.19.1` 与当前 runtime 不兼容；没有授予版本豁免或改动该插件的配置。

观察面板只读，每秒显示 Bridge 已接收的任务阶段、方案、近期日志、验证与审查；ACP 会话仍由原执行者持有。真实 Host 测试不发送模型 prompt，也没有替代用户桌面端冷启动后的交互验收。需要升级 Bridge 到 0.1.2，再在 DSH 右侧新建面板中选择 Codex Bridge；必要时先打开或选择一个 DSH 聊天以显示右侧面板。

## 0.1.2 历史安装包校验

文件：`release/Codex DSH Bridge Setup 0.1.2.exe`

SHA-256：`F5E45E7C33A6DD58FA45ACA59B0B8E8BC0FBFA1DB3D39D5E2D6BEBEC2465C5B6`

## 0.1.1 自动接入修复

故障已在本机复现：旧版选择 npm 的无扩展名 `codex` 脚本，Windows 启动时返回 `ENOENT`。回归检查先验证旧行为失败，再验证修复后找到原生 `codex.exe`。启动时也会修复已经保存的 wrapper 路径。

| 检查 | 命令／方式 | 结果 |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | 通过 |
| 路径、Windows 进程及打包 MCP | 设置 `BRIDGE_PACKAGED_EXECUTABLE` 后执行 `node --test --test-name-pattern='Windows native Codex\|Windows job runner\|packaged Electron' dist/tests/bridge.test.js` | 3 项通过，无跳过或失败；未重跑整套基线测试 |
| 本机原生 Codex | 自动解析保存的 npm wrapper 路径，运行 `--version` | 返回 `codex-cli 0.159.2`，退出 0 |
| 打包版迁移及界面 | 隔离目录预置旧 wrapper 设置，启动 0.1.1 `--smoke-test` | 保存路径迁移为 `.exe`；页面、托盘关闭与恢复、重复启动、DPAPI、任务详情及纯文本日志通过 |
| 本机已安装 MCP | 官方 SDK 启动 `E:\Codex DSH Bridge` 安装版本，列出工具并读取不存在的任务 ID | 四个工具可用；请求到达桌面服务，返回预期的“找不到任务。” |
| 真实 DSH 元数据 | `npm run doctor:acp` | 会话新建／关闭／恢复通过；返回模型选择值；没有发送 prompt |
| 安装包 | `npm run package` | 0.1.1 NSIS x64 安装包生成成功，尚未覆盖用户正在运行的 0.1.0 |

按用户要求，已备份并更新当前用户的 `.codex/config.toml` 为 `E:\Codex DSH Bridge` 安装路径。TOML 解析及原有设置保留检查通过；没有修改 Plus 登录或 API 凭据。

## 尚需真实使用验收

没有发送真实 DSH 编码 prompt，也没有调用真实付费 OpenAI API。协议握手及模拟服务结果不能代替模型端到端验收。

首次使用时，在软件中核对 DSH 路径和模型配置，完成 Codex 接入，然后在一个已有干净 Git 基准的小项目中调用 `$codex-dsh-bridge`。本机已手动接入，无需重复点击安装。核对窗口中的真实执行与验证、Codex 审查，以及最终本地 commit。付费路线需在软件窗口配置独立 API Key／可用模型，并手动启动一次审查；失败或复审不自动另开一次审查。

软件接入需用户触发。本轮按用户要求手动更新了当前 Codex 接入配置，保留 Plus 登录、真实项目与远程仓库。交付的 `MCP-config.toml` 对应本机 `E:\Codex DSH Bridge` 安装路径；其他安装路径应由软件窗口生成配置。
