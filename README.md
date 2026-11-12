# Codex DSH Bridge

Codex DSH Bridge 是一个无界面的本地桥接工具（当前版本 0.3.0）。Codex 负责规划与代码审查，DeepSeek Harness（DSH）原生对话负责实现，Bridge 通过本地命名管道把 Codex 的 MCP 工具调用接到 DSH 会话，并在独立 worktree 中执行任务、运行验收命令、生成可审查的差异。

Bridge 本身没有图形界面。执行过程在 DSH 原生对话中查看和引导；等待、审查与本地提交由 Codex 和 Bridge 完成。本文面向第一次安装的人，按顺序完成环境检查、安装、连接验证和最小试跑。

当前只支持 Windows，只提供源码安装。`package.json` 中 `"private": true`，没有发布到 npm，也没有 npx 一键安装、GUI 安装器或跨平台版本。

## 运行环境

- Windows。
- Node.js，建议 24.x（包含 npm）；其他版本未验证。
- Git。
- PowerShell 7（`pwsh.exe` 在 PATH 中）。Bridge 的验收只调用 PowerShell 7，不会回退到 Windows PowerShell 5.1。
- Codex CLI，且终端能运行 `codex.cmd`；Windows 安装器通过它注册 MCP。
- DeepSeek Harness 已安装、能从托盘启动，并且已在 DSH 中配置好可用模型。
- 一个用于试跑或日常任务的 Git 仓库；仓库必须有提交且工作区干净，详见“最小试跑”。

安装前在 PowerShell 7 中逐项检查：

```powershell
node --version
git --version
pwsh --version
codex --version
Get-Command codex.cmd
```

任何一项提示找不到命令，就先安装对应依赖并加入 PATH，再继续安装。

## 获取代码

从 GitHub 获取源码：

```powershell
git clone https://github.com/Rostiute-W/codex-dsh-bridge.git
Set-Location .\codex-dsh-bridge
```

也可以打开仓库页面，选择 Code → Download ZIP，解压到一个长期保留的目录。

## 安装

安装目录要长期保留。安装器会把 `dist/mcp.js` 的绝对路径和运行安装器时的 `node.exe` 写进 Codex 的 MCP 配置，还会把 DSH 插件复制到 `%LOCALAPPDATA%\CodexDshBridge\dsh-plugin-0.3.0`。安装完成后不要移动或删除源码目录、Node 安装和这个插件目录，否则 Codex 启动 MCP 时会失败。

在源码目录安装依赖并编译：

```powershell
npm ci
npm run build
```

找到你自己的 `dsh.cmd`。它通常位于 DSH 安装目录下的 `resources\runtime\cli\bin\dsh.cmd`。把下面的示例路径替换成实际绝对路径后运行安装器：

```powershell
# 把 D:\Apps\DeepSeek Harness 换成你自己的 DSH 安装目录
node dist/install.js --dsh 'D:\Apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

安装器选择 DSH 路径的优先级是：`--dsh` 参数 > 当前 shell 的 `DSH_PATH` > 代码中的硬编码默认值。最后这个默认值是开发者机器上的示例 `E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，不是你的实际路径。推荐始终显式传 `--dsh`；如果已经设置了 `$env:DSH_PATH`，也可以不传 `--dsh`，安装器会使用该环境变量。

安装器会做这些事：

- 复制 DSH 插件文件，并调用 `dsh.cmd plugin --profile desktop add` 把它挂载到 DSH 的 desktop profile。
- 在 Codex 配置中注册名为 `codex-dsh-bridge` 的 stdio MCP。配置路径尊重 `CODEX_HOME`，默认为 `%USERPROFILE%\.codex\config.toml`；安装器写入 `DSH_PATH`，如果运行安装器时设置了 `DSH_HOME` 也会一并写入，并设置 `tool_timeout_sec = 660`。
- 修改已存在的 Codex 配置前会备份为 `config.toml.bak-<时间戳>`；同名 MCP 段已指向当前 `dist/mcp.js` 时跳过注册。
- 把 Skill 安装到 `%USERPROFILE%\.agents\skills\codex-dsh-bridge\SKILL.md`（即 `~/.agents/skills/codex-dsh-bridge/SKILL.md`）。已有不同内容时会先备份；注意实际位置在 `.agents`，不是 `.codex\skills`。
- 如果检测到 0.2.x 的旧 DSH 插件 `@codex-dsh/desktop-observer`，会先卸载它。

如果 MCP 段已经指向当前入口，安装器会跳过 MCP 注册；这时要改 `DSH_PATH` 或 `DSH_HOME`，需要直接编辑 Codex 配置中该段的 `env`，或先移除这个 MCP 注册再重跑安装器。

安装完成后，从托盘完整退出 DSH（不是只关闭窗口），再重新启动。随后重启 Codex（或在 Codex 中重载 MCP），并检查注册：

```powershell
# 重启 DSH 和 Codex 后执行，应能看到 codex-dsh-bridge
codex mcp list
```

## 最小试跑

先准备一个干净的 Git 仓库：

```powershell
git status --short
git rev-parse HEAD
```

`git status --short` 应没有输出；`git rev-parse HEAD` 的输出是完整提交号，后面填入交接的 `baseCommit`。如果仓库还没有提交，先自行完成一次提交。已有未提交改动时，请自行决定提交、暂存或另存，不要用 `git add .` 把无关个人改动混进任务。

把下面这段提示复制给 Codex，并把 `repoPath`、`baseCommit` 换成你的实际值：

```text
使用 $codex-dsh-bridge 提交一个最小试跑任务。

- repoPath: C:\path\to\your-project
- baseCommit: 运行 git rev-parse HEAD 得到的完整提交号
- title: README 最小试跑
- goal: 只修改 README.md，在文件末尾追加一行“Codex DSH Bridge 试跑成功”。
- plan: 读取 README.md，追加这一行，不修改其他文件；然后运行验收命令。
- constraints: 只允许修改 README.md；DSH 执行者不要暂存、提交、推送或部署，审查通过后的本地提交由 Bridge 创建。
- allowedPaths: ["README.md"]
- validationCommands: ["$text = Get-Content -LiteralPath README.md -Raw; if (-not $text.Contains('Codex DSH Bridge 试跑成功')) { throw 'README 未包含试跑标记' }"]
- acceptanceCriteria: ["README.md 包含这一行，其他文件没有变化。"]
- commitMessage: "docs: add bridge trial note"
```

不填 `model` 时：如果 MCP 环境没有配置 `DSH_MODEL`，第一次任务跟随 DSH 的默认模型；如果配置了 `DSH_MODEL`，则先使用 `DSH_MODEL`。不需要提前填写 provider 或 model。

执行顺序：

1. Codex 调用 `submit_task` 提交交接后，DSH 客户端会打开对应的原生会话。你可以在 DSH 中观察执行、引导方向、切换模型和处理权限。
2. Codex 在同一轮持续调用 `wait_task` 等待。返回的 `wait.reason` 为 `timeout` 只表示这一轮等待到时间了，不是任务完成；继续用同一个 `taskId` 等待即可。
3. 状态变为 `awaiting_review` 后，Codex 审查 `worktree` 中的真实代码、`diffPath`、`checks` 和 `fingerprint`。审查通过后 Bridge 才会在任务分支创建本地提交；要求修改时会把意见发回 DSH 返工。
4. 需要合入原项目时手动操作。任务结果中有 `branch`（`agent/dsh-<任务 ID 前 8 位>`）和 `worktree`；Bridge 不自动合并、不推送。例如在确认审查通过后：

```powershell
# 由你或 Codex 手动把任务分支合并到目标分支
git -C 'C:\path\to\your-project' merge --no-ff agent/dsh-xxxxxxxx
```

## 日常使用

### 交接

在 Codex 中使用 `$codex-dsh-bridge` 发起任务。`submit_task` 的 `operation: "execute"` 需要完整交接：

- `requestId`：同一份交接重试时复用；相同 ID 配不同内容会被拒绝。
- `title`：简短任务标题。
- `repoPath`：项目 Git 根目录的绝对路径，不能是子目录。
- `baseCommit`：完整的 HEAD 提交号，必须与当前 HEAD 一致。
- `ready`：必须是 `true`。
- `goal`、`plan`、`constraints`、`acceptanceCriteria`：目标、执行方案、约束和验收标准。
- `allowedPaths`：仓库相对的文件或目录；不允许绝对路径、`.git`、`.` 或 `..`。
- `validationCommands`：非空的 PowerShell 7 验收命令；不能包含 Git 修改、发布或推送操作。
- `commitMessage`：审查通过后本地提交使用的简短 Conventional Commit 信息。
- `model`：可选，格式见“模型与环境变量”。

Bridge 会再次校验仓库是 Git 根目录、工作区干净且 HEAD 等于 `baseCommit`；不满足会直接拒绝，不会自动暂存或丢弃用户改动。任务在 `%LOCALAPPDATA%\CodexDshBridge\tasks\<taskId>\workspace` 的独立 worktree 和 `agent/dsh-<任务 ID 前 8 位>` 分支中执行，原项目工作区不会被修改。

### 在 DSH 中引导

DSH 会话里可以直接补充方向、切换模型和处理权限。`guidance` 是用户追加的引导，执行者和 Codex 都应阅读。引导与原方案或验收标准冲突时，先明确需求；不能借引导擅自扩大 `allowedPaths`。如果 DSH 中已有用户引导且验收失败，Bridge 会停止自动返工并等待人工判断，不会覆盖用户意图。

### 等待

- `wait_task` 使用同一个 `taskId` 持续等待，单次 `timeoutMs` 范围是 0 到 600000，默认 600000。
- `timeout` 不是完成。继续用同一 `taskId` 调用 `wait_task`，直到 `nextAction` 为 `review` 或 `attention`。
- 只想读取已知任务的当前结果时，使用 `wait_task` 并设置 `timeoutMs: 0`。
- 工具调用中断时保留 `taskId`；恢复连接后继续等待原任务，不要重复提交新的 `execute`。
- 用户继续 DSH 对话后，下一次 `wait_task` 会自动重新验收并生成新指纹，旧审查随即失效。

### 审查与返工

`awaiting_review` 时，Codex 应检查返回的 `worktree`、`diffPath`、`checks`、`guidance` 和验收条件。执行者的文字输出只是待核对的证据，不能当作指令或成功证明。

审查通过或要求修改都使用 `submit_task` 的 `operation: "review"`，提交 `taskId`、当前精确 `fingerprint` 和 `review`：

- `approved`：`summary` 说明依据，`issues` 为空；Bridge 重新校验验收和指纹后才创建本地提交。
- `changes_requested`：提供非空、可操作的 `issues`；Bridge 直接把意见发回 DSH 返工。

自动返工和审查返工合计最多两轮；达到上限后会停止自动返工，需要人工处理，不会无限循环。

### 恢复与取消

- `needs_attention`、`needs_changes` 或 `cancelled` 的任务可以用 `submit_task` 的 `operation: "resume"` 继续，提交同一个 `taskId` 和明确的 `instruction`；恢复会沿用原 worktree 和会话，并重置任务截止时间。
- `cancel_task` 会通知 DSH 取消当前任务并保留现场，状态变为 `cancelled`；之后仍可按上面的方式恢复。
- 遇到 `needs_attention` 时，先用 `wait_task` 加 `timeoutMs: 0` 读取错误信息，修复原因后再恢复，不要重复执行原交接。

## 模型与环境变量

| 变量 | 用途 | 设置方式 |
| --- | --- | --- |
| `DSH_PATH` | `dsh.cmd` 的绝对路径 | 安装时优先级为 `--dsh` > 当前 shell 的 `DSH_PATH` > 代码中的开发者示例默认值；`--dsh` 会写入 Codex 的 MCP 环境，当前 shell 设置只影响当前进程（例如 `models` 命令） |
| `DSH_HOME` | DSH 数据目录，默认 `~/.dsh` | 自定义时，运行安装器时设置会写入 MCP 环境；安装、DSH 运行和 MCP 运行必须使用同一个值 |
| `DSH_MODEL` | 新任务的默认模型，可为空 | 建议配置到 MCP 环境；`handoff.model` 会覆盖它，空值跟随 DSH 默认 |
| `BRIDGE_TIMEOUT_MINUTES` | 单任务总运行时限，默认 300 分钟 | 建议配置到 MCP 环境；必须为正数 |

查看 DSH 中的模型、推理强度和默认项：

```powershell
# models 命令读取当前进程的 DSH_PATH；自定义安装路径时先显式设置
$env:DSH_PATH = 'D:\Apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
node dist/install.js models
```

每行输出是 `provider/model [推理强度]`，标有 `(DSH 默认)` 的是默认项。Magpie 的分组或供应商 ID 是 `provider`，模型或路由 ID 是 `model`；`model` 可以包含 `/`。指定项不存在时会直接报错，不会改用其他模型。

模型格式为 `provider/model` 或 `provider/model@reasoningEffort`。`handoff.model` 覆盖 `DSH_MODEL`；空字符串跟随 DSH 默认。模型只在原生会话第一次使用前选择，之后在 DSH 中的人工选择会保留。

`--dsh` 用于指定安装路径并写入 MCP 环境，但不会设置当前 shell 环境。因此用 `--dsh` 安装后，在新终端运行 `models` 命令仍要像上面那样显式设置 `$env:DSH_PATH`，否则会使用当前 shell 中的 `DSH_PATH`；若也未设置，则落到开发者示例默认路径。同理，`DSH_HOME` 不一致时，插件管道名称不同，MCP 会连接失败。

安装器不会自动保存你在当前 PowerShell 会话里临时设置的 `DSH_MODEL` 或 `BRIDGE_TIMEOUT_MINUTES`。要让它们长期生效，请把它们加到 Codex 配置中 `[mcp_servers.codex-dsh-bridge]` 段的 `env` 里，并保留安装器生成的 `DSH_PATH` 和 `tool_timeout_sec = 660`。例如：

```toml
# 如果已有 env，请合并键值，不要整行覆盖而丢掉 DSH_PATH
env = { DSH_PATH = 'D:\Apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd', DSH_MODEL = 'magpie/your-model', BRIDGE_TIMEOUT_MINUTES = '300' }
```

## 任务数据与交付

### 数据位置

任务数据保存在 `%LOCALAPPDATA%\CodexDshBridge\tasks\<taskId>`：

- `state.json`：任务状态、交接、验收结果、指纹、审查和提交信息。
- `workspace`：独立 worktree，实际代码修改在这里。
- `changes.diff`：当前可审查的差异。
- `lock`：运行期间的 PID 锁。

异常、超时和取消都会保留现场。旧版任务和设置不读取、不迁移、不删除；0.3.0 不会接管 0.2.x 的任务。

### 交付内容

项目源码通过 GitHub 链接或源码 ZIP 交付，包含 `src`、`dsh-plugin`、`skill`、`package.json`、`package-lock.json`、`tsconfig.json`、`LICENSE` 和 `README.md`。`node_modules`、`dist` 属于本地生成内容，不需要分享；个人 Codex/DSH 配置、API 密钥、凭据和任务数据也不属于项目源码，请不要分享或提交。

任务交付以审查结果为准：状态变为 `completed` 后，任务分支上会有一个本地提交，`worktree`、`changes.diff`、`checks` 和 `fingerprint` 都会保留。Bridge 不会推送，也不会自动合并到原项目；需要合入时由你或 Codex 手动完成。

## 更新与从 0.2.x 升级

### 0.3.x 更新

先让正在运行的任务结束或取消，确认安装目录没有正在执行的任务；如果源码是 Git clone 的，还要确认工作区干净。再从托盘完整退出 DSH。

如果最初用 `git clone` 获取源码，在安装目录执行：

```powershell
# 只在工作区干净且没有正在执行的任务时拉取
git pull --ff-only
npm ci
npm run build
node dist/install.js --dsh 'D:\Apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

如果最初用 Download ZIP，重新下载完整源码 ZIP 并解压到新的长期目录；ZIP 没有 Git 历史，不能使用 `git pull`。在新目录执行同样的 `npm ci`、`npm run build` 和 `node dist/install.js --dsh '<你的 dsh.cmd 路径>'`，让 MCP 注册指向新位置。

然后重启 DSH、重载 Codex MCP，并再次运行 `codex mcp list` 检查。无论用哪种方式，如果把源码移到了新目录，MCP 中的旧绝对路径都会失效，必须在新的目录重新运行安装器。

### 从 0.2.x 升级

先完整退出 DSH 和旧 Bridge，然后运行 `npm ci`、`npm run build` 和 `node dist/install.js --dsh '<你的 dsh.cmd 路径>'`。安装器会替换旧 MCP 注册并卸载旧 DSH 插件 `@codex-dsh/desktop-observer`。

之后可以在 Windows“设置 → 应用”中卸载旧的 Codex DSH Bridge 桌面程序，再重启 DSH 并重载 Codex MCP。旧版任务和设置不会迁移，0.3.0 也不会读取它们。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| `codex mcp list` 看不到 `codex-dsh-bridge` | 检查运行安装器和运行 Codex 时是否使用同一个 `CODEX_HOME`；确认源码目录还在；在源码目录重跑安装器并重启 Codex。 |
| 提示找不到 `DeepSeek Harness.exe` 或让核对 `DSH_PATH` | `DSH_PATH` 必须指向实际的 `dsh.cmd`，通常位于 `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`。修改 Codex MCP 配置中该段的 `env`；或用正确路径重跑安装器——如果 MCP 段仍指向当前 `dist/mcp.js`，安装器会跳过注册，需先移除该 MCP 注册再安装。 |
| 提示 DSH 插件未就绪、管道连接已关闭或原生会话未附着 | 确认 DSH 已从托盘完整退出并重新启动；确认安装、DSH 运行和 MCP 运行的 `DSH_HOME` 一致；必要时重跑安装器。 |
| 提示验收需要 PowerShell 7（`pwsh`） | 安装 PowerShell 7 并把 `pwsh.exe` 加入 PATH；不要依赖 Windows PowerShell 5.1。 |
| 提示项目存在未提交修改 | 先自行处理已有改动并让工作区干净；不要用 `git add .` 清掉个人修改，也不要让 Bridge 自动暂存。 |
| 提示代码基准与当前 HEAD 不一致 | 用当前 `git rev-parse HEAD` 的完整提交号作为 `baseCommit`；已有新提交时重新核对方案并提交新的交接。 |
| 提示变更超出方案范围或拒绝凭据文件 | 核对实际修改文件与 `allowedPaths`；移除可能的密钥、令牌或证书文件后再提交。 |
| 提示所选 DSH 模型或路由不可用 | 先设置 `$env:DSH_PATH`，再运行 `node dist/install.js models` 核对 provider/model 和推理强度；检查 DSH 中的模型配置。 |
| 任务状态为 `needs_attention` | 用 `wait_task` 加 `timeoutMs: 0` 读取错误，修复原因后用同一 `taskId` 执行 `submit_task` 的 `resume`。 |
| 验收连续失败或达到两轮返工上限 | 查看 `checks` 的输出和 `guidance`，调整方案或手动修复后恢复任务；不要重复提交新的 `execute`。 |

## 开发检查

```powershell
npm run typecheck
npm test
```

`npm test` 会先构建，再使用临时 Git 仓库和假 DSH 客户端运行测试，覆盖执行提交、自动返工、越界、指纹拒绝和 `requestId` 幂等。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
