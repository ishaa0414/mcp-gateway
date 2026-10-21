import { z } from 'zod'

/**
 * What the gateway's playground route answers with, and what the server action hands the browser.
 * The browser gets values, never thrown errors, so each case has its own message.
 */

const requestPreview = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
})

const responsePreview = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
  bodyBytes: z.number(),
  binary: z.boolean(),
  truncated: z.boolean(),
})

export const playgroundRunSchema = z.object({
  /** The tool call itself worked (false for a validation error, an upstream 4xx/5xx, a timeout, …). */
  ok: z.boolean(),
  errorClass: z.string().nullable(),
  message: z.string().nullable(),
  latencyMs: z.number(),
  request: requestPreview.nullable(),
  response: responsePreview.nullable(),
})

export type PlaygroundRun = z.infer<typeof playgroundRunSchema>
export type RequestPreview = z.infer<typeof requestPreview>
export type ResponsePreview = z.infer<typeof responsePreview>

export type PlaygroundFailure =
  | 'unauthenticated'
  | 'not_found'
  | 'confirmation_required'
  | 'not_configured'
  | 'misconfigured'
  | 'unavailable'
  | 'gateway_timeout'

export type PlaygroundResult =
  | { status: 'ok'; run: PlaygroundRun }
  /** The gateway rejected the arguments; `message` is its own wording. */
  | { status: 'invalid'; message: string }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: PlaygroundFailure }

/** The sentence shown for every result that is not a run. */
export function describeResult(result: Exclude<PlaygroundResult, { status: 'ok' }>): string {
  switch (result.status) {
    case 'invalid':
      return result.message
    case 'rate_limited':
      return `Too many playground calls for this project. Try again in ${result.retryAfterSeconds} second${result.retryAfterSeconds === 1 ? '' : 's'}.`
    case 'unauthenticated':
      return 'Your session has ended. Sign in again to use the playground.'
    case 'not_found':
      return 'This tool is not available. It may have been disabled or removed; reload the page.'
    case 'confirmation_required':
      return 'This tool changes data on your API. Confirm to send it.'
    case 'not_configured':
      return 'The playground is not configured.'
    case 'misconfigured':
      return 'The playground is misconfigured. Ask whoever runs this deployment to check that the dashboard and the gateway share the same playground secret.'
    case 'unavailable':
      return 'The gateway is not available right now. Check that it is running, then try again.'
    case 'gateway_timeout':
      return 'The gateway did not respond in time. Your API may be slow, or the gateway may be starting up. Try again.'
  }
}
