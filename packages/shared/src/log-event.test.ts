import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGE_MAX_CHARS, LOG_ERROR_CLASSES, logEventSchema, sanitizeErrorMessage } from './log-event.js'

const valid = {
  id: 'evt_1',
  kind: 'TOOL_CALL',
  projectId: 'proj_1',
  apiKeyId: 'key_1',
  toolId: 'tool_1',
  toolName: 'getPet',
  input: { petId: 1 },
  upstreamStatus: 200,
  latencyMs: 12,
  success: true,
  errorClass: null,
  errorMessage: null,
  responseBytes: 340,
  timestamp: 1_760_000_000_000,
}

describe('logEventSchema', () => {
  it('accepts a tool call', () => {
    expect(logEventSchema.parse(valid)).toEqual(valid)
  })

  it('accepts an auth failure that only knows the slug', () => {
    const rest: Record<string, unknown> = { ...valid }
    delete rest['projectId']
    const event = { ...rest, kind: 'AUTH_FAILURE', projectSlug: 'petstore', apiKeyId: null, toolId: null, toolName: null, input: {}, upstreamStatus: null, success: false, errorClass: 'AUTH_INVALID' }
    expect(logEventSchema.parse(event)).toMatchObject({ kind: 'AUTH_FAILURE', projectSlug: 'petstore' })
  })

  it('survives a JSON round trip (the queue and the buffer carry JSON)', () => {
    expect(logEventSchema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it('needs a projectId or a projectSlug', () => {
    const rest: Record<string, unknown> = { ...valid }
    delete rest['projectId']
    expect(logEventSchema.safeParse(rest).success).toBe(false)
  })

  it.each([
    ['an unknown error class', { errorClass: 'SOMETHING' }],
    ['an unknown kind', { kind: 'OTHER' }],
    ['a negative latency', { latencyMs: -1 }],
    ['a fractional latency', { latencyMs: 1.5 }],
    ['an out-of-range status', { upstreamStatus: 99 }],
    ['a message over the limit', { errorMessage: 'x'.repeat(ERROR_MESSAGE_MAX_CHARS + 1) }],
    ['non-object input', { input: 'text' }],
    ['an empty id', { id: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(logEventSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })

  it('lists every error class once', () => {
    expect(new Set(LOG_ERROR_CLASSES).size).toBe(LOG_ERROR_CLASSES.length)
  })
})

describe('sanitizeErrorMessage', () => {
  it('keeps a plain sentence', () => {
    expect(sanitizeErrorMessage('The upstream API returned HTTP 404 Not Found.')).toBe('The upstream API returned HTTP 404 Not Found.')
  })

  it('keeps the first line only', () => {
    expect(sanitizeErrorMessage('first line\nsecond line with detail')).toBe('first line')
  })

  it.each([
    ['a full URL', 'failed for https://api.example.com/v1/pets?api_key=SECRET123 today', 'SECRET123'],
    ['a URL with credentials in the query', 'GET http://10.0.0.5:8080/x?token=abc&k=SECRET123', 'SECRET123'],
    ['a bare query string', 'bad request near /pets?key=SECRET123&x=1', 'SECRET123'],
    ['a redirect Location', 'redirect to //evil.example/steal?k=SECRET123', 'SECRET123'],
    ['a non-http scheme', 'ftp://user:SECRET123@host/file', 'SECRET123'],
  ])('removes %s', (_label, text, secret) => {
    const out = sanitizeErrorMessage(text)
    expect(out).not.toContain(secret)
    expect(out).not.toMatch(/:\/\//)
    expect(out).not.toMatch(/\?[^[]/)
  })

  it('truncates to the limit', () => {
    const out = sanitizeErrorMessage('word '.repeat(500))
    expect(out.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
  })

  it('stays fast on a huge message', () => {
    const started = performance.now()
    sanitizeErrorMessage('a'.repeat(5_000_000))
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('handles empty text', () => {
    expect(sanitizeErrorMessage('')).toBe('')
  })
})
