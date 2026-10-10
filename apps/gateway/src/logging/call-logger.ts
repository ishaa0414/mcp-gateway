import { randomUUID } from 'node:crypto'
import { maskArguments, ProjectSlugSchema, sanitizeErrorMessage } from '@mcp-gateway/shared'
import type { LogErrorClass, LogEvent } from '@mcp-gateway/shared'
import type { Logger } from '../config.js'
import type { LogSink } from './sink.js'
import { SampleThrottle } from './throttle.js'

const TOOL_NAME_MAX_CHARS = 128

export interface ToolCallRecord {
  projectId: string
  apiKeyId: string
  /** The name the agent asked for (it may not be a real tool). */
  toolName: string
  /** The tool, when it exists. */
  tool?: { id: string; agentSchema: Record<string, unknown> }
  /** What the agent sent, unmasked. Masked here, before it goes anywhere. */
  args: unknown
  latencyMs: number
  success: boolean
  errorClass?: LogErrorClass | undefined
  errorMessage?: string | undefined
  upstreamStatus?: number | undefined
  responseBytes?: number | undefined
}

export type AuthFailureReason = 'AUTH_MISSING' | 'AUTH_INVALID' | 'AUTH_WRONG_PROJECT'

export interface CallLoggerOptions {
  /** One sampled event (auth failure or rate-limit rejection) per key per interval. */
  sampleIntervalMs?: number
  sampleMaxKeys?: number
  /** Cap on sampled events across all keys per interval. */
  sampleMaxPerInterval?: number
  now?: () => number
}

/**
 * Builds call-log events and hands them to the sink. Everything here is guarded: a problem
 * while building or queueing an event is logged and swallowed, because logging must never
 * fail or slow a tool call.
 */
export class CallLogger {
  private readonly sampled: SampleThrottle
  private readonly now: () => number

  constructor(
    private readonly sink: LogSink,
    private readonly log: Logger,
    options: CallLoggerOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.sampled = new SampleThrottle(options.sampleIntervalMs ?? 10_000, options.sampleMaxKeys ?? 1_000, options.sampleMaxPerInterval ?? 200, this.now)
  }

  /** Events skipped by sampling since the process started. */
  get suppressed(): number {
    return this.sampled.suppressed
  }

  /** A `tools/call` that reached a handler (it succeeded, failed, or named an unknown tool). */
  toolCall(record: ToolCallRecord): void {
    this.safely(() => this.sink.enqueue(this.toolCallEvent(record)))
  }

  /** A `tools/call` turned away by the rate limiter. Sampled per key: a key being hammered logs one row per interval. */
  rateLimited(record: Pick<ToolCallRecord, 'projectId' | 'apiKeyId' | 'toolName' | 'tool' | 'args'>): void {
    this.safely(() => {
      if (!this.sampled.allow(`rl:${record.apiKeyId}`)) return
      this.sink.enqueue(
        this.toolCallEvent({ ...record, latencyMs: 0, success: false, errorClass: 'RATE_LIMITED', errorMessage: 'Rate limit exceeded' })
      )
    })
  }

  /**
   * A request that failed authentication. The only thing known about the caller is the project slug in
   * the URL, so that is all that is stored, besides the reason: never the key, its hash or any prefix of it.
   * Slugs that cannot be real are not recorded at all.
   */
  authFailure(slug: string, reason: AuthFailureReason): void {
    this.safely(() => {
      if (!ProjectSlugSchema.safeParse(slug).success) return
      if (!this.sampled.allow(`auth:${slug}:${reason}`)) return
      this.sink.enqueue({
        id: randomUUID(),
        kind: 'AUTH_FAILURE',
        projectSlug: slug,
        apiKeyId: null,
        toolId: null,
        toolName: null,
        input: {},
        upstreamStatus: null,
        latencyMs: 0,
        success: false,
        errorClass: reason,
        errorMessage: null,
        responseBytes: null,
        timestamp: this.now(),
      })
    })
  }

  private toolCallEvent(r: ToolCallRecord): LogEvent {
    return {
      id: randomUUID(),
      kind: 'TOOL_CALL',
      projectId: r.projectId,
      apiKeyId: r.apiKeyId,
      toolId: r.tool?.id ?? null,
      toolName: cleanToolName(r.toolName),
      input: maskArguments(r.args, r.tool ? { schema: r.tool.agentSchema } : {}).value,
      upstreamStatus: r.upstreamStatus ?? null,
      latencyMs: Math.max(0, Math.round(r.latencyMs)),
      success: r.success,
      errorClass: r.success ? null : (r.errorClass ?? 'INTERNAL'),
      errorMessage: r.success || !r.errorMessage ? null : sanitizeErrorMessage(r.errorMessage),
      responseBytes: r.responseBytes ?? null,
      timestamp: this.now(),
    }
  }

  private safely(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not record a call log event')
    }
  }
}

/** The tool name comes from the agent, so it is masked like any argument and cut to a storable length. */
function cleanToolName(name: string): string {
  const masked = maskArguments({ name }).value['name']
  return (typeof masked === 'string' ? masked : '').slice(0, TOOL_NAME_MAX_CHARS)
}
