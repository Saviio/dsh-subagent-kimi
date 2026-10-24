import { randomUUID } from 'node:crypto'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  AssistantOutputFold,
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

export type KimiPermissionMode = 'reject' | 'yolo' | 'auto'

export const KIMI_PERMISSION_MODES = [
  'reject',
  'yolo',
  'auto',
] as const satisfies readonly KimiPermissionMode[]

export const DEFAULT_KIMI_PERMISSION_MODE: KimiPermissionMode = 'yolo'
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

export interface KimiRunSpec {
  readonly cwd: string
  readonly model?: string
  readonly permissionMode: KimiPermissionMode
  readonly env: Record<string, string>
  readonly disposeEofGraceMs: number
  readonly disposeGraceMs: number
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

type KimiFailureStage =
  | 'initialize'
  | 'new-session'
  | 'configure-session'
  | 'prompt'
  | 'process'
  | 'teardown'

type KimiFailureCategory =
  | 'protocol'
  | 'configuration'
  | 'transport'
  | 'process-start'
  | 'process-exit'
  | 'remote-limit'
  | 'invalid-result'
  | 'unknown'

interface KimiFailureFacts {
  readonly stage: KimiFailureStage
  readonly category: KimiFailureCategory
  readonly stopReason?: StopReason | 'unknown'
  readonly outcome?: SubprocessOutcome | undefined
}

interface KimiPermissionDecision {
  readonly mode: KimiPermissionMode
  readonly request: ToolKind | 'unknown'
  readonly decision: 'allowed' | 'denied'
}

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])

function failureDiagnostic(facts: KimiFailureFacts): string {
  const fields = [
    'product: Kimi Code CLI',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.stopReason !== undefined) {
    fields.push(`stop reason: ${facts.stopReason}`)
  }
  if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) {
    fields.push(`exit code: ${facts.outcome.exitCode}`)
  }
  if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) {
    fields.push(`signal: ${facts.outcome.signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

function permissionDiagnostic(permission: KimiPermissionDecision): string {
  return `Kimi unattended decision (mode: ${permission.mode}; request: ${permission.request}; decision: ${permission.decision})`
}

function diagnosticText(
  facts: KimiFailureFacts,
  permission?: KimiPermissionDecision,
): string {
  const failure = failureDiagnostic(facts)
  return permission === undefined
    ? failure
    : `${failure}\n${permissionDiagnostic(permission)}`
}

class KimiRunFailure extends Error {
  constructor(facts: KimiFailureFacts, cause?: unknown) {
    super(
      `subagent-kimi: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'KimiRunFailure'
  }
}

export function kimiConfigurationFailure(cause: unknown): Error {
  return new KimiRunFailure({
    stage: 'initialize',
    category: 'configuration',
  }, cause)
}

export function kimiAcpArgv(): string[] {
  return ['kimi', 'acp']
}

export function kimiTextTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-kimi: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-kimi: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-kimi: the one-shot task must not be empty')
  }
  return texts
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function reportFailure(spec: KimiRunSpec, error: unknown): void {
  try {
    spec.onError?.(toError(error), 'error')
  } catch {
    // Logging must not replace the child failure.
  }
}

function permissionRequestKind(kind: ToolKind | null | undefined): ToolKind | 'unknown' {
  const candidate = kind ?? 'unknown'
  return ACP_TOOL_KINDS.has(candidate) ? candidate : 'unknown'
}

async function rangeExitsWithin(
  child: SubprocessHandle,
  ms: number,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function disposeKimiChild(
  child: SubprocessHandle,
  eofGraceMs: number,
): Promise<void> {
  const failures: Error[] = []
  child.stdin?.end()
  let exited = false
  try {
    exited = await rangeExitsWithin(child, eofGraceMs)
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (exited) return
  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (failures.length === 1) throw failures[0] as Error
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Kimi subprocess teardown failed')
  }
}

export function kimiStopReason(reason: StopReason): SubagentStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    case 'max_turn_requests':
      return 'error'
    default:
      return 'error'
  }
}

export function kimiContentText(content: AcpContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

function startupFailure(
  error: unknown,
  stage: Extract<
    KimiFailureStage,
    'initialize' | 'new-session' | 'configure-session'
  >,
  outcome: SubprocessOutcome | undefined,
): KimiRunFailure {
  return new KimiRunFailure(
    outcome === undefined
      ? { stage, category: 'transport' }
      : { stage, category: 'process-exit', outcome },
    error,
  )
}

function terminalFailure(
  reason: StopReason,
  permission: KimiPermissionDecision | undefined,
): string | undefined {
  switch (reason) {
    case 'end_turn':
      return undefined
    case 'max_turn_requests':
      return diagnosticText({
        stage: 'prompt',
        category: 'remote-limit',
        stopReason: 'max_turn_requests',
      }, permission)
    case 'max_tokens':
    case 'refusal':
    case 'cancelled':
      return permission === undefined
        ? undefined
        : permissionDiagnostic(permission)
    default:
      return diagnosticText({
        stage: 'prompt',
        category: 'unknown',
        stopReason: 'unknown',
      }, permission)
  }
}

export async function startKimiRun(
  request: SubagentStartRequest,
  spec: KimiRunSpec,
): Promise<SubagentRun> {
  const texts = kimiTextTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-kimi: request was aborted before ACP startup')
  }
  const id = brandString<SessionId>(randomUUID())

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: kimiAcpArgv(),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    reportFailure(spec, error)
    throw new KimiRunFailure({
      stage: 'process',
      category: 'process-start',
    }, error)
  }
  if (child.stdin === undefined || child.stdout === undefined) {
    child.terminate()
    await child.waitForExit().catch(() => false)
    throw new KimiRunFailure({
      stage: 'process',
      category: 'process-start',
    })
  }

  let processOutcome: SubprocessOutcome | undefined
  let processFailure: Error | undefined
  const processDone = child.done.then(
    (outcome) => {
      processOutcome = outcome
      return outcome
    },
    (error: unknown) => {
      processFailure = toError(error)
      throw processFailure
    },
  )
  const processRejected: Promise<never> = processDone.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(toError(error)),
  )
  processRejected.catch(() => {})

  const observeProcessOutcome = async (
    signal?: AbortSignal,
  ): Promise<SubprocessOutcome | undefined> => {
    if (processOutcome !== undefined) return processOutcome
    const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs))
    const bound = signal === undefined
      ? timeout
      : AbortSignal.any([signal, timeout])
    const aborted = Promise.withResolvers<undefined>()
    const onObservationAbort = (): void => { aborted.resolve(undefined) }
    bound.addEventListener('abort', onObservationAbort, { once: true })
    if (bound.aborted) onObservationAbort()
    try {
      return await Promise.race([processDone, aborted.promise])
    } catch {
      return processOutcome
    } finally {
      bound.removeEventListener('abort', onObservationAbort)
    }
  }

  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (
    processDisposal ??= disposeKimiChild(child, spec.disposeEofGraceMs)
  )

  const fold = new AssistantOutputFold()
  const flags = { cancelled: false }
  let latestPermission: KimiPermissionDecision | undefined
  const acpPermission = spec.permissionMode === 'auto' ? 'allow' : 'reject'

  const clientApp = createAcpClientApp({ name: 'dsh-subagent-kimi' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk') {
        fold.pushText(kimiContentText(update.content))
      }
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      if (acpPermission === 'allow') {
        const allow = params.options.find(
          option => option.kind === 'allow_once' || option.kind === 'allow_always',
        )
        if (allow !== undefined) {
          latestPermission = {
            mode: spec.permissionMode,
            request: permissionRequestKind(params.toolCall.kind),
            decision: 'allowed',
          }
          return Promise.resolve({
            outcome: { outcome: 'selected', optionId: allow.optionId },
          })
        }
      }
      latestPermission = {
        mode: spec.permissionMode,
        request: permissionRequestKind(params.toolCall.kind),
        decision: 'denied',
      }
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    })

  const connection = clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  const agent = connection.agent

  let sessionId: string | undefined
  let startupStage: Extract<
    KimiFailureStage,
    'initialize' | 'new-session' | 'configure-session'
  > = 'initialize'
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => {
    signalCancelSettled = resolve
  })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
    if (sessionId !== undefined) {
      void agent.notify(methods.agent.session.cancel, { sessionId })
        .catch(() => {})
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = (): readonly ContentBlock[] => fold.collect() ?? []

  try {
    await Promise.race([
      (async (): Promise<void> => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        startupStage = 'new-session'
        const session = await agent.request(methods.agent.session.new, {
          cwd: spec.cwd,
          mcpServers: [],
        })
        const returnedSessionId: unknown = Reflect.get(session, 'sessionId')
        if (typeof returnedSessionId !== 'string' || returnedSessionId.length === 0) {
          throw new KimiRunFailure({
            stage: 'new-session',
            category: 'protocol',
          }, new Error('Kimi ACP published without a session id'))
        }
        sessionId = returnedSessionId
        startupStage = 'configure-session'
        await agent.request(methods.agent.session.setMode, {
          sessionId: returnedSessionId,
          modeId: spec.permissionMode === 'reject' ? 'default' : spec.permissionMode,
        })
        if (spec.model !== undefined) {
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: returnedSessionId,
            configId: 'model',
            value: spec.model,
          })
        }
        if (flags.cancelled) {
          throw new Error('subagent-kimi: cancelled before the ACP session started')
        }
      })(),
      processRejected,
      cancelSettled.then((): never => {
        throw new Error('subagent-kimi: cancelled before the ACP session started')
      }),
    ])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = flags.cancelled
    const observedOutcome = !cancelledBeforeCleanup && !(error instanceof KimiRunFailure)
      ? await observeProcessOutcome()
      : undefined
    const startup = cancelledBeforeCleanup
      ? { kind: 'cancelled' } as const
      : {
        kind: 'failed',
        failure: error instanceof KimiRunFailure
          ? error
          : startupFailure(error, startupStage, observedOutcome),
      } as const
    if (startup.kind === 'failed') {
      reportFailure(
        spec,
        error instanceof KimiRunFailure ? error.cause : processFailure ?? error,
      )
    }
    try {
      await disposeProcess()
    } catch (cleanupError: unknown) {
      reportFailure(spec, cleanupError)
      const cleanupFailure = new KimiRunFailure({
        stage: 'teardown',
        category: processOutcome === undefined ? 'unknown' : 'process-exit',
        ...processOutcome === undefined ? {} : { outcome: processOutcome },
      }, cleanupError)
      if (startup.kind === 'cancelled') {
        throw new AggregateError([cleanupFailure], cleanupFailure.message)
      }
      throw new AggregateError(
        [startup.failure, cleanupFailure],
        `${startup.failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (startup.kind === 'cancelled') {
      throw new Error('subagent-kimi: request was aborted before ACP startup')
    }
    throw startup.failure
  }

  if (sessionId === undefined) {
    throw new Error('subagent-kimi: ACP startup fulfilled without a session id')
  }
  const remoteSessionId = sessionId

  let diagnostic: string | undefined
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async (): Promise<SubagentResult> => {
      try {
        const promptResult = await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId: remoteSessionId,
            prompt: texts.map(text => ({ type: 'text', text })),
          }),
          cancelSettled.then((): never => {
            throw new Error('subagent-kimi: cancelled while the ACP prompt was running')
          }),
        ]) as { stopReason: StopReason }
        const stopReason = kimiStopReason(promptResult.stopReason)
        const output = collectOutput()
        const hasAnswer = output.some(
          block => block.type === 'text' && block.text.trim().length > 0,
        )
        diagnostic = terminalFailure(promptResult.stopReason, latestPermission)
        if (stopReason === 'completed' && !hasAnswer) {
          diagnostic = diagnosticText({
            stage: 'prompt',
            category: 'invalid-result',
          }, latestPermission)
          return { output, diagnostic, stopReason: 'error' }
        }
        return {
          output,
          ...diagnostic === undefined ? {} : { diagnostic },
          stopReason,
        }
      } catch (error: unknown) {
        if (!flags.cancelled) {
          const outcome = await observeProcessOutcome(request.signal)
          const facts = outcome === undefined
            ? { stage: 'prompt', category: 'transport' } as const
            : { stage: 'process', category: 'process-exit', outcome } as const
          diagnostic = diagnosticText(facts, latestPermission)
        }
        throw processFailure ?? error
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        await disposeProcess()
      } catch (error: unknown) {
        reportFailure(spec, error)
        throw new KimiRunFailure({
          stage: 'teardown',
          category: processOutcome === undefined ? 'unknown' : 'process-exit',
          ...processOutcome === undefined ? {} : { outcome: processOutcome },
        }, error)
      }
    },
  })
}
