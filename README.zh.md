# dsh-subagent-kimi

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一次性 [Kimi Code CLI](https://www.kimi.com/code/docs/en/) 子智能体插件，通过 Agent Client Protocol（ACP）驱动真实 Kimi 进程。

每次委派都会在指定工作目录中启动独立的 Kimi 进程和 ACP 会话。父会话传入一个自包含的文本任务，并接收助手回答或安全的终止诊断；推理过程、工具流量和原始协议消息不会进入父会话。

## 环境要求

- Node.js 24.9.0 或更高版本。
- DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`，已验证 `0.2.1-rc.2` 和 `0.2.1-rc.3`。
- 可通过 `PATH` 找到 Kimi Code CLI（`kimi`），并已在 Kimi 中配置认证和模型提供商。已验证版本为 2.3.1，建议使用当前发布版。

安装或升级 Kimi，然后检查版本和认证：

```sh
npm install -g @moonshot-ai/kimi-code@latest
kimi --version
kimi login
```

Provider 每次委派都通过 subprocess 服务的 `PATH` 查找启动 `kimi`，插件本身不携带 Kimi 运行时。Kimi 原生配置和认证仍以 `KIMI_CODE_HOME` 或 `~/.kimi-code` 为准。

## 安装

将 Bundle 安装进 DeepSeek Harness Profile，`<name>` 替换为 `web`、`headless`、`sdk`、`acp` 或自定义 Profile 名称：

```sh
dsh plugin --profile <name> add dsh-subagent-kimi
```

该命令通过 `pnpm` 管理 Profile 依赖，因此需要确保 `pnpm` 在 `PATH` 中。如果 DSH 提示需要重启，请重启后使用。在 Web 或 Desktop 中，也可以打开 **Plugins → 添加插件**，输入 `dsh-subagent-kimi`，然后安装并启用该 Bundle。

对于自定义 Node 组合，`npm install dsh-subagent-kimi` 只安装 JavaScript 依赖，不等同于在 DSH Profile 中安装并启用插件。此时需要按下面的示例挂载 provider 和工具，或将 Bundle 纳入自己的组合。

Bundle 元数据会加载 `cordis.patch.yml`、注册 `kimi` provider，并将 `subagent_kimi` 添加为 Harness 全局工具。仅加载 Bundle 不会启动 Kimi；只有实际发生委派时才创建进程。

如需手工挂载 provider 和工具：

```yaml
- insert:
    - id: subagent-kimi
      name: 'dsh-subagent-kimi'
    - id: tool-subagent-kimi
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: kimi
        toolName: subagent_kimi
        maxDepth: provider-managed
```

## 配置

```yaml
- id: subagent-kimi
  name: 'dsh-subagent-kimi'
  config:
    providerName: kimi
    model: kimi-code/kimi-for-coding # 可选
    permissionMode: reject
    env: {}
    disposeEofGraceMs: 6000
    disposeGraceMs: 3000
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providerName` | `kimi` | 在 `ctx.subagents` 中注册的非空名称；每个挂载实例必须使用不同名称。 |
| `model` | Kimi 原生设置 | 可选模型别名，在会话创建后通过 ACP `session/set_config_option` 设置，不发现或改写别名。 |
| `env` | `{}` | 显式子进程环境，叠加在 subprocess 服务清除凭据后的父环境之上。 |
| `permissionMode` | `reject` | ACP 会话模式和无人值守权限处理方式，见下表。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 后等待协作式退出的毫秒数，超时才升级终止。 |
| `disposeGraceMs` | `3000` | 进程状态观察和托管终止的毫秒宽限期。两个值都必须为有限正数，且不能超过 Node 计时器上限。 |

Harness subprocess 服务会清除父环境中形似凭据的变量；`env` 中显式配置的值仍会转发，包括凭据类值。因此不要将 API key 提交到 Profile 文件。

### 权限模式

| 值 | ACP 会话模式 | ACP 权限请求 |
| --- | --- | --- |
| `reject` | `default`，人工批准模式 | 取消所有请求 |
| `yolo` | `yolo`，常规编辑和命令按 Kimi 原生 yolo 策略执行 | 取消剩余请求，包括高风险操作和提问 |
| `auto` | `auto`，Kimi 原生自动策略 | 如果仍收到请求，选择首个 `allow_once` 或 `allow_always` 选项 |

所有模式都不会在父 Harness 会话中建立人工交互通道。`auto` 可以在无人批准的情况下修改文件和执行命令，只应在可信且适当隔离的工作目录中使用。

**`reject` 不是沙箱，也不是只读保证。** 它只拒绝 Kimi 通过 ACP 发出的请求；Kimi 不发起 ACP 请求就直接允许的操作仍可能执行。需要限制副作用时，请使用操作系统或 Harness 工作区隔离。

## 行为与结果

- 仅接受非空文本块序列；图片等内容类型会在启动进程前被拒绝。
- 每次运行都通过 `PATH` 启动独立的 `kimi acp` 可执行文件和 ACP 会话，不复用进程，不支持追加输入或恢复会话。使用 Kimi 自己的可执行文件而不是 DSH 的 Electron 二进制，也避免了 macOS 在 Dock 中再注册一个 DSH/Electron 应用。
- 启动时完成 ACP `initialize`、`session/new`、`session/set_mode` 和可选的 `session/set_config_option`，成功后才发布 run；配置失败使用 `configure-session` 阶段，并先清理尚未发布的私有进程。
- `session/prompt` 只执行一次任务。收集流式 `agent_message_chunk` 文本；思考、计划、工具调用等更新会被消费但不作为结果返回。
- ACP 停止原因映射为 Harness 的 `completed`、`max-tokens`、`refusal`、`aborted` 或 `error`。未知原因，以及声称成功却没有任何助手文本的情况，均按错误处理。
- 取消会尽力发送 `session/cancel`，在本地及时结算，并最终由进程清理兜底。
- 清理时先关闭 stdin 并等待 EOF 协作退出，再通过共享 subprocess 所有者分级终止，并等待整个进程范围静止。
- 失败诊断只包含固定的产品、阶段、类别，以及可选的停止原因、退出码和信号。原始 stderr、异常文本、任务内容、环境值、路径和协议负载不会复制到模型可见诊断中；Host 内部日志会保留可用的原始错误。

Provider 不继承父对话，也不声明任何可选 start capabilities。需要 `agentPreset`、`agentOptions`、结构化输出或 Harness 深度限制的请求会由共享 subagent 服务拒绝。

## 限制

- Kimi ACP 会话是原生 Kimi 会话，一次性任务结束后可能仍保留在本地历史中。本插件不会将其标记为临时会话，也不会自动删除。
- 插件不会创建账号、登录、选择模型提供商或修复 Kimi 配置。认证问题会以安全的启动或 prompt 失败诊断呈现。
- 每次运行仅处理一个文本任务，不支持续聊、恢复、进度流或父上下文继承。
- 没有内置墙钟超时，也不会回滚取消前已经发生的文件或外部系统副作用。
- Kimi 原生设置、hooks、skills 和账号状态会影响子进程。部署策略需要独立 Kimi home 时，可在 `env` 中显式设置 `KIMI_CODE_HOME`，并在该 home 中单独配置认证。
- 用户负责 Kimi 的安装和升级。DSH 可见的 `PATH` 必须解析到兼容的 Kimi CLI。已验证版本为 2.3.1；旧版本不会被显式拒绝，但必须支持本插件使用的 ACP 方法。
- 兼容基线为 Kimi Code CLI 2.3.1、ACP SDK 1.4.0 和 DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`，已验证 DSH `0.2.1-rc.2` 和 `0.2.1-rc.3`。超出这些基线升级 Kimi 或 DSH 后，应重新完成协议和真实产品验证。

## 开发

```sh
npm install
npm run clean
npm run typecheck
npm run build
npm pack --dry-run
```

实现参考 DeepSeek Harness 的 Codex 产品 provider 结构，并针对 Kimi Code CLI 调整其 ACP 子进程生命周期。上游资料：

- [`subagent-codex`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex)
- [`subagent-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-acp)
- [Kimi `acp` 文档](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Kimi 命令文档](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)

基于 MIT 发布，详见 [LICENSE](LICENSE)。
