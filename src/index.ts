import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  assertUsableCwd,
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_KIMI_PERMISSION_MODE,
  KIMI_PERMISSION_MODES,
  kimiConfigurationFailure,
  startKimiRun,
  type KimiPermissionMode,
  type KimiRunSpec,
} from './run.ts'

export const name = 'subagent-kimi'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'kimi'

export interface Config {
  /** Provider name on `ctx.subagents` (default `kimi`). */
  providerName?: string
  /** Kimi model alias fixed for this provider; omitted to inherit Kimi settings. */
  model?: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /** Non-interactive Kimi launch and ACP permission behavior. */
  permissionMode?: KimiPermissionMode
  /** Grace in milliseconds for cooperative EOF shutdown before termination. */
  disposeEofGraceMs?: number
  /** Grace in milliseconds between managed subprocess termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...KIMI_PERMISSION_MODES])
    .default(DEFAULT_KIMI_PERMISSION_MODE),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'model'> & Pick<Config, 'model'>

class KimiProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-kimi', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error('subagent-kimi: request was aborted before ACP startup')
      }
      const failure = kimiConfigurationFailure(error)
      this.ctx.logger.warn(
        `subagent-kimi "${this.name}": child start failed: %o`,
        failure,
      )
      throw failure
    }
    const spec: KimiRunSpec = {
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-kimi "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startKimiRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env ?? {},
    permissionMode: config.permissionMode ?? DEFAULT_KIMI_PERMISSION_MODE,
    disposeEofGraceMs: config.disposeEofGraceMs ?? DEFAULT_DISPOSE_EOF_GRACE_MS,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  for (const [field, value] of [
    ['disposeEofGraceMs', resolved.disposeEofGraceMs],
    ['disposeGraceMs', resolved.disposeGraceMs],
  ] as const) {
    assertPositiveFinite('subagent-kimi', field, value)
    if (value > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `subagent-kimi: ${field} must be no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
  }
  ctx.subagents.registerProvider(new KimiProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
