import { describe, expect, it } from 'vitest'
import { annotationsForMethod } from './annotations.js'

describe('annotationsForMethod', () => {
  it.each(['GET', 'HEAD', 'get'])('%s is read-only and not destructive', (method) => {
    expect(annotationsForMethod(method)).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true })
  })

  it('DELETE is destructive and idempotent', () => {
    expect(annotationsForMethod('DELETE')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  it('PUT is idempotent but not destructive', () => {
    expect(annotationsForMethod('PUT')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  it.each(['POST', 'PATCH', 'patch'])('%s is not read-only and not idempotent', (method) => {
    expect(annotationsForMethod(method)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  it('treats an unexpected method as a state-changing, non-idempotent call', () => {
    expect(annotationsForMethod('TRACE')).toMatchObject({ readOnlyHint: false, idempotentHint: false })
  })

  it('always marks tools as open-world, since they call an external API', () => {
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(annotationsForMethod(m).openWorldHint).toBe(true)
    }
  })
})
