# dsh-subagent-kimi

English | [中文](README.zh.md)

A one-shot [Kimi Code CLI](https://www.kimi.com/code/docs/en/) subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), using the Agent Client Protocol (ACP).

Each delegation starts a fresh Kimi process and ACP session in the selected workspace. The parent supplies one self-contained text task and receives the assistant text or a safe terminal diagnostic. Reasoning, tool traffic, and raw protocol messages stay out of the parent conversation.

## Requirements

- Node.js 24.9.0 or later.
- DeepSeek Harness packages on the verified `0.2.1-rc.3` release line.
- Kimi Code authentication and provider settings configured through Kimi Code CLI. Run `kimi login` or configure Kimi normally before delegating.

The package pins `@moonshot-ai/kimi-code@2.3.1` and invokes its package-local CLI. It does **not** execute `kimi` from the host `PATH`, and there is no host-CLI fallback. Native Kimi configuration and authentication remain authoritative under `KIMI_CODE_HOME` or `~/.kimi-code`.

## Install

Install `dsh-subagent-kimi` through the DeepSeek Harness plugin/bundle manager, or add it to the Node project containing your Harness composition:

```sh
npm install dsh-subagent-kimi
```

The bundle metadata loads `cordis.patch.yml`, registers the `kimi` provider, and exposes `subagent_kimi` as a global Harness tool. Loading the bundle does not start Kimi; a process is created only for an actual delegation.

To mount the provider and tool manually, use:

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

## Configuration

```yaml
- id: subagent-kimi
  name: 'dsh-subagent-kimi'
  config:
    providerName: kimi
    model: kimi-code/kimi-for-coding # optional
    permissionMode: reject
    env: {}
    disposeEofGraceMs: 6000
    disposeGraceMs: 3000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `providerName` | `kimi` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique name. |
| `model` | Kimi native settings | Optional model alias set through ACP `session/set_config_option` after session creation. No alias discovery or rewriting is performed. |
| `env` | `{}` | Explicit child environment layered over the subprocess service's credential-scrubbed parent environment. |
| `permissionMode` | `reject` | ACP session mode and unattended permission behavior; see below. |
| `disposeEofGraceMs` | `6000` | Time in milliseconds allowed for cooperative shutdown after stdin EOF before termination escalation. |
| `disposeGraceMs` | `3000` | Process-observation and managed termination grace in milliseconds. Both grace values must be positive, finite, and within Node's timer limit. |

Credential-shaped ambient variables are scrubbed by the Harness subprocess service. Values explicitly present in `env` are forwarded, including credential-shaped values, so do not commit API keys to profile files.

### Permission modes

| Value | ACP session mode | ACP permission requests |
| --- | --- | --- |
| `reject` | `default`; manual approvals | Cancel every request |
| `yolo` | `yolo`; routine edits and commands run under Kimi's native yolo policy | Cancel remaining requests, including risky actions and questions |
| `auto` | `auto`; Kimi's native automatic policy | Select the first `allow_once` or `allow_always` option if a request still arrives |

No mode creates a human interaction channel in the parent Harness session. `auto` can modify files and execute commands without human approval; use it only in trusted, appropriately isolated workspaces.

**`reject` is not a sandbox or a read-only guarantee.** It denies requests that Kimi sends over ACP, but operations Kimi permits without making an ACP request can still proceed. Use operating-system or Harness workspace isolation when side effects must be constrained.

## Behavior

- The provider accepts only a non-empty sequence of text blocks. Images and other content types are rejected before a process starts.
- Every run uses a new package-local `node <kimi-code> acp` process and a new ACP session. There is no process pooling, follow-up input, or resume.
- Startup completes ACP `initialize`, `session/new`, `session/set_mode`, and optional `session/set_config_option` before publishing the run. Configuration failures use the `configure-session` stage and clean up the private process before rejecting.
- `session/prompt` executes exactly one task. Streamed `agent_message_chunk` text is collected; thoughts, plans, tool calls, and other updates are consumed but not returned.
- ACP stop reasons map to Harness `completed`, `max-tokens`, `refusal`, `aborted`, or `error`. Unknown reasons and a successful stop with no assistant text are treated as errors.
- Cancellation sends best-effort `session/cancel`, settles locally without waiting for a cooperative child, and remains backed by process teardown.
- Disposal closes stdin, waits for cooperative EOF shutdown, then escalates through the shared managed subprocess owner and waits for process-range quiescence.
- Failures expose only fixed product/stage/category facts and optional stop reason, exit code, and signal. Raw stderr, exception text, task content, environment values, paths, and protocol payloads are not copied into model-visible diagnostics. Internal Host logging retains the original error where available.

The provider advertises no optional start capabilities and does not inherit the parent conversation. Requests requiring `agentPreset`, `agentOptions`, structured output, or Harness-enforced depth limits are rejected by the shared subagent service.

## Limitations

- Kimi ACP sessions are native Kimi sessions and may remain in Kimi's local session history after the one-shot run. This provider does not mark them ephemeral or delete them.
- The package does not create an account, log in, select a provider, or repair Kimi configuration. Authentication failures remain Kimi startup/prompt failures with safe diagnostics.
- One run is one text-only task. There is no continuation, resume, progress stream, or parent-context inheritance.
- There is no built-in wall-clock timeout and no rollback of files or external systems changed before cancellation.
- Native Kimi settings, hooks, skills, and account state can affect the child. Use an explicit isolated `KIMI_CODE_HOME` in `env` when deployment policy requires a separate Kimi home, and configure authentication there separately.
- Compatibility is pinned by development evidence to Kimi Code CLI 2.3.1, ACP SDK 1.4.0, and DeepSeek Harness 0.2.1-rc.3. Upgrade these together only after rerunning protocol and real-product verification.

## Development

```sh
npm install
npm run clean
npm run typecheck
npm run build
npm pack --dry-run
```

The implementation follows DeepSeek Harness's Codex product-provider structure and adapts its ACP subprocess lifecycle for Kimi Code CLI. Upstream references:

- [`subagent-codex`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex)
- [`subagent-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-acp)
- [Kimi `acp` reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)

Released under MIT; see [LICENSE](LICENSE).
