import { logEventSchema, type LogEvent } from '@mcp-gateway/shared'
import { describe, expect, it, vi } from 'vitest'
import { CallLogger } from './call-logger.js'
import type { LogSink } from './sink.js'

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
function setup(options: ConstructorParameters<typeof CallLogger>[2] = {}) {
  const events: LogEvent[] = []
  const sink: LogSink = { enqueue: (e) => void events.push(e), close: async () => undefined }
  const logger = log()
  return { callLog: new CallLogger(sink, logger, options), events, logger }
}

const base = { projectId: 'p1', apiKeyId: 'k1', toolName: 'createPet', latencyMs: 12.6, success: true as const }

describe('CallLogger.toolCall', () => {
  it('builds a valid event with the fields of the call', () => {
    const { callLog, events } = setup({ now: () => 1_700_000_000_000 })
    callLog.toolCall({ ...base, tool: { id: 't1', agentSchema: {} }, args: { name: 'Rex' }, upstreamStatus: 201, responseBytes: 42 })

    expect(events).toHaveLength(1)
    expect(logEventSchema.parse(events[0])).toMatchObject({
      kind: 'TOOL_CALL',
      projectId: 'p1',
      apiKeyId: 'k1',
      toolId: 't1',
      toolName: 'createPet',
      input: { name: 'Rex' },
      upstreamStatus: 201,
      latencyMs: 13,
      success: true,
      errorClass: null,
      errorMessage: null,
      responseBytes: 42,
      timestamp: 1_700_000_000_000,
    })
    expect(events[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('gives every event its own id', () => {
    const { callLog, events } = setup()
    callLog.toolCall({ ...base, args: {} })
    callLog.toolCall({ ...base, args: {} })
    expect(events[0]!.id).not.toBe(events[1]!.id)
  })

  it('masks arguments before they leave, using the tool schema too', () => {
    const { callLog, events } = setup()
    const schema = { type: 'object', properties: { pin: { type: 'string', format: 'password' } } }
    callLog.toolCall({ ...base, tool: { id: 't1', agentSchema: schema }, args: { pin: '1234', password: 'hunter2', note: 'Bearer abcdef123456' } })

    expect(events[0]!.input).toEqual({ pin: '[MASKED]', password: '[MASKED]', note: '[MASKED]' })
  })

  it('records a failure with its class and message', () => {
    const { callLog, events } = setup()
    callLog.toolCall({ ...base, success: false, errorClass: 'UPSTREAM_5XX', errorMessage: 'The upstream API returned HTTP 500 Internal Server Error.', upstreamStatus: 500, args: {} })
    expect(events[0]).toMatchObject({ success: false, errorClass: 'UPSTREAM_5XX', errorMessage: 'The upstream API returned HTTP 500 Internal Server Error.' })
  })

  it('stores no message on success, and INTERNAL when a failure has no class', () => {
    const { callLog, events } = setup()
    callLog.toolCall({ ...base, errorMessage: 'ignored on success', args: {} })
    callLog.toolCall({ ...base, success: false, args: {} })
    expect(events[0]).toMatchObject({ errorClass: null, errorMessage: null })
    expect(events[1]).toMatchObject({ errorClass: 'INTERNAL' })
  })

  it('sanitises the message once more (no URL or query string gets through)', () => {
    const { callLog, events } = setup()
    callLog.toolCall({ ...base, success: false, errorClass: 'UNREACHABLE', errorMessage: 'failed: https://api.example.com/x?api_key=SECRET', args: {} })
    expect(events[0]!.errorMessage).not.toContain('SECRET')
    expect(events[0]!.errorMessage).not.toContain('://')
  })

  it('cuts and masks the tool name, which the agent chose', () => {
    const { callLog, events } = setup()
    callLog.toolCall({ ...base, toolName: 'x'.repeat(500), args: {} })
    callLog.toolCall({ ...base, toolName: 'mcpg_abcdefghijklmnop', args: {} })
    expect(events[0]!.toolName).toHaveLength(128)
    expect(events[1]!.toolName).toBe('[MASKED]')
    expect(() => logEventSchema.parse(events[0])).not.toThrow()
  })

  it('stays valid for odd arguments', () => {
    const { callLog, events } = setup()
    callLog.toolCall({ ...base, args: undefined })
    callLog.toolCall({ ...base, args: 'a string' })
    callLog.toolCall({ ...base, args: { big: 'z'.repeat(2_000_000) } })
    for (const e of events) expect(() => logEventSchema.parse(e)).not.toThrow()
    expect(JSON.stringify(events[2]).length).toBeLessThan(1_000)
  })

  it('never throws, even if the sink does', () => {
    const logger = log()
    const callLog = new CallLogger(
      {
        enqueue: () => {
          throw new Error('sink exploded')
        },
        close: async () => undefined,
      },
      logger
    )
    expect(() => callLog.toolCall({ ...base, args: {} })).not.toThrow()
    expect(() => callLog.authFailure('petstore', 'AUTH_INVALID')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith({ err: 'sink exploded' }, 'could not record a call log event')
  })
})

describe('CallLogger.authFailure', () => {
  it('records the slug and the reason, and nothing about the key', () => {
    const { callLog, events } = setup()
    callLog.authFailure('petstore', 'AUTH_INVALID')

    expect(events).toHaveLength(1)
    expect(logEventSchema.parse(events[0])).toMatchObject({
      kind: 'AUTH_FAILURE',
      projectSlug: 'petstore',
      apiKeyId: null,
      toolId: null,
      toolName: null,
      input: {},
      success: false,
      errorClass: 'AUTH_INVALID',
      errorMessage: null,
    })
    expect(events[0]!.projectId).toBeUndefined()
  })

  it.each(['', 'ab', 'Has Caps', 'x'.repeat(49), 'bad/slug', '../etc', 'a b c'])('ignores the impossible slug %j', (slug) => {
    const { callLog, events } = setup()
    callLog.authFailure(slug, 'AUTH_INVALID')
    expect(events).toHaveLength(0)
  })

  it('samples: one row per slug and reason per interval', () => {
    let now = 0
    const { callLog, events } = setup({ now: () => now, sampleIntervalMs: 10_000 })
    for (let i = 0; i < 100; i++) callLog.authFailure('petstore', 'AUTH_INVALID')
    callLog.authFailure('petstore', 'AUTH_MISSING') // another reason: its own row
    callLog.authFailure('other-shop', 'AUTH_INVALID') // another slug: its own row
    expect(events).toHaveLength(3)
    expect(callLog.suppressed).toBe(99)

    now = 10_000
    callLog.authFailure('petstore', 'AUTH_INVALID')
    expect(events).toHaveLength(4)
  })
})

describe('CallLogger.rateLimited', () => {
  it('records a RATE_LIMITED call with zero latency, masked arguments and the tool when known', () => {
    const { callLog, events } = setup()
    callLog.rateLimited({ projectId: 'p1', apiKeyId: 'k1', toolName: 'createPet', tool: { id: 't1', agentSchema: {} }, args: { name: 'Rex', token: 'abc' } })

    expect(events[0]).toMatchObject({
      kind: 'TOOL_CALL',
      toolId: 't1',
      toolName: 'createPet',
      input: { name: 'Rex', token: '[MASKED]' },
      latencyMs: 0,
      success: false,
      errorClass: 'RATE_LIMITED',
      upstreamStatus: null,
    })
  })

  it('samples per key: a key hammering the limit logs one row per interval', () => {
    const { callLog, events } = setup({ now: () => 0, sampleIntervalMs: 10_000 })
    const rejected = { projectId: 'p1', apiKeyId: 'k1', toolName: 'x', args: {} }
    for (let i = 0; i < 500; i++) callLog.rateLimited(rejected)
    callLog.rateLimited({ ...rejected, apiKeyId: 'k2' })
    expect(events).toHaveLength(2)
    expect(callLog.suppressed).toBe(499)
  })
})
