'use server'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { env, gatewayInternalUrl } from '@/lib/env'
import { playgroundRunSchema, type PlaygroundResult } from '@/lib/playground/result'
import { newPlaygroundNonce, PLAYGROUND_HEADERS, playgroundRequestTimeoutMs, signPlaygroundRequest } from '@mcp-gateway/shared'
import { z } from 'zod'

/**
 * Run one tool from the Playground. Checks that the signed-in user owns the project and that the tool is
 * an enabled one of it, then asks the gateway to run it (signed with PLAYGROUND_SECRET) and hands back
 * the gateway's masked request and response. Every outcome is a value. Arguments, requests and
 * responses are never logged.
 */

const Input = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,48}$/),
  toolId: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
  confirmed: z.boolean().optional(),
})

export async function runPlayground(input: z.input<typeof Input>): Promise<PlaygroundResult> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { status: 'unauthenticated' }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { status: 'invalid', message: 'The request was not valid.' }
  const { slug, toolId, confirmed } = parsed.data

  const settings = env()
  const secret = settings.PLAYGROUND_SECRET
  if (!secret) return { status: 'not_configured' }

  // Project by owner, then the tool by project: another user's slug, a disabled or removed tool and
  // another project's tool are all the same answer.
  const project = await db.project.findFirst({ where: { slug, userId }, select: { id: true } })
  const tool = project
    ? await db.tool.findFirst({ where: { id: toolId, projectId: project.id, enabled: true, removedAt: null }, select: { name: true, method: true } })
    : null
  if (!tool) return { status: 'not_found' }

  // This calls the real API with the real credential. Anything but a GET needs the user's confirmation,
  // checked here before any network call (the gateway checks it too).
  const changesData = tool.method.toUpperCase() !== 'GET'
  if (changesData && confirmed !== true) return { status: 'confirmation_required' }

  const body = JSON.stringify({ tool: tool.name, arguments: parsed.data.arguments, ...(changesData ? { confirmed: true } : {}) })
  const timestamp = Date.now()
  const nonce = newPlaygroundNonce()
  const signature = signPlaygroundRequest(secret, { timestamp, nonce, slug, tool: tool.name, body })

  let response: Response
  try {
    response = await fetch(`${gatewayInternalUrl(settings)}/internal/playground/${slug}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLAYGROUND_HEADERS.timestamp]: String(timestamp),
        [PLAYGROUND_HEADERS.nonce]: nonce,
        [PLAYGROUND_HEADERS.signature]: signature,
      },
      body, // the exact text that was signed
      signal: AbortSignal.timeout(playgroundRequestTimeoutMs(settings.TOOL_CALL_TIMEOUT_MS)),
      redirect: 'error',
      cache: 'no-store',
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { status: 'gateway_timeout' }
    console.warn('[playground] the gateway could not be reached:', err instanceof Error ? err.message : 'unknown error')
    return { status: 'unavailable' }
  }

  return mapGatewayResponse(response)
}

async function mapGatewayResponse(response: Response): Promise<PlaygroundResult> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  const error = typeof payload === 'object' && payload !== null ? (payload as { error?: unknown }).error : undefined

  if (response.ok) {
    const run = playgroundRunSchema.safeParse(payload)
    if (!run.success) {
      console.warn('[playground] the gateway answered with an unexpected body')
      return { status: 'unavailable' }
    }
    // The gateway checks the arguments with the tool's schema; its message is shown as it is.
    if (run.data.errorClass === 'VALIDATION') return { status: 'invalid', message: run.data.message ?? 'The arguments were not valid.' }
    return { status: 'ok', run: run.data }
  }

  switch (response.status) {
    case 404:
      return { status: 'not_found' }
    case 400:
      return error === 'confirmation_required' ? { status: 'confirmation_required' } : { status: 'invalid', message: 'The request was not valid.' }
    case 401:
      if (error === 'unauthorized') {
        // The signature did not verify: the two sides hold different secrets (or the clocks are far apart).
        console.error('[playground] the gateway refused the signature: PLAYGROUND_SECRET differs between the dashboard and the gateway, or their clocks differ by more than a minute')
        return { status: 'misconfigured' }
      }
      return { status: 'unavailable' } // 'replayed', which a fresh nonce makes a retry-able oddity
    case 429: {
      const retry = typeof payload === 'object' && payload !== null ? Number((payload as { retryAfterSeconds?: unknown }).retryAfterSeconds) : NaN
      return { status: 'rate_limited', retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60 }
    }
    default:
      console.warn(`[playground] the gateway answered HTTP ${response.status}`)
      return { status: 'unavailable' }
  }
}
