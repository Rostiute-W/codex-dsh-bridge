# Codex DSH Bridge

无界面的本地桥接：Codex 通过 MCP stdio 提交方案，Node 进程通过命名管道驱动 DSH 原生对话。用户在 DSH 中引导方向、切换模型和处理权限。

需要 Windows、Node.js、Git、PowerShell 7，以及已配置好模型的 DeepSeek Harness。

## 安装

```powershell
npm install
npm run build
node dist/install.js
# 自定义 DSH 命令入口：
node dist/install.js --dsh 'E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

安装器复制插件、注册 MCP 和安装 Skill；覆盖不同内容的 Skill 或新增、替换 MCP 配置前会备份。同名 MCP 段已指向当前入口时跳过，否则移除旧注册并重新添加。安装后从托盘完整退出并重启 DSH，再在 Codex 重载 MCP。

### 从 0.2.x 升级

先完整退出 DSH 和旧 Bridge。
运行 `npm install && npm run build && node dist/install.js`，会替换旧 MCP 注册并卸载旧 DSH 插件。
之后可以在 Windows“应用”里卸载旧的 Codex DSH Bridge 桌面程序。
重启 DSH 并重载 Codex MCP。

环境变量：

| 变量 | 用途 |
| --- | --- |
| `DSH_PATH` | DSH CLI 路径，默认 `E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| `DSH_HOME` | DSH 数据目录，默认 `~/.dsh`；安装与 MCP 运行时必须一致 |
| `DSH_MODEL` | 新任务模型，可空；`provider/model` 或 `provider/model@reasoningEffort` |
| `BRIDGE_TIMEOUT_MINUTES` | 每次任务运行总时限，默认 300 分钟 |

运行 `node dist/install.js models` 列出模型、推理强度和 DSH 默认项。Magpie 的分组或供应商 ID 是 provider，模型或路由 ID 是 model；model 可以含 `/`。指定项不存在时直接报错。handoff.model 覆盖环境默认值，空字符串跟随 DSH 默认；只在原生会话首次使用前选择模型，后续保留用户在 DSH 中的选择。

## 使用

在 Codex 中调用 `$codex-dsh-bridge`。交接必须包含干净 Git 根目录、完整 baseCommit、明确 allowedPaths 和 PowerShell 验收命令。

- `submit_task`：execute 提交 handoff；review 提交指纹与审查意见；resume 继续待处理、待修改或已取消任务。
- `wait_task`：持续等到 review/attention；timeout 继续等，`timeoutMs: 0` 只读结果。DSH 对话继续后，下一次等待自动重新验收。
- `cancel_task`：通知 DSH 取消，保留现场。

每任务独立 worktree 和分支。Bridge 校验范围、拦截凭据文件、运行 PowerShell 7 验收；实际代码和会话游标都与审查绑定。验收通过且 Codex 批准后才创建本地提交，最多两轮自动与审查返工，不推送、不自动合并原项目。DSH 用户引导存在且验收失败时停止自动返工。

数据保存在 `%LOCALAPPDATA%\CodexDshBridge\tasks\<id>`：`state.json`、`workspace`、`changes.diff`、运行中的 PID 锁。中断后通过 wait_task 接管仍在运行或验收的任务；异常、超时和取消均保留文件。旧版任务和设置不读取、不迁移、不删除。

## 开发检查

```powershell
npm run typecheck
npm test
```

测试仅使用临时 Git 仓库与假 DSH 客户端，覆盖执行提交、自动返工、越界、指纹拒绝与 requestId 幂等。
