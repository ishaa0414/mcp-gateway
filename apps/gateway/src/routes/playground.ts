import type { PrismaClient } from '@mcp-gateway/db'
import { PLAYGROUND_HEADERS, PLAYGROUND_WINDOW_MS, verifyPlaygroundRequest, z } from '@mcp-gateway/shared'
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify'
import type { Redis } from 'ioredis'
import { loadProjectConfig } from '../cache/project-config.js'
import type { SafeRedis } from '../cache/safe-redis.js'
import type { AppConfig, Logger } from '../config.js'
import { callUpstream, type ValidatorCache } from '../mcp/call-tool.js'
import type { RateLimiter } from '../ratelimit/limiter.js'

export interface PlaygroundRouteDeps {
  db: PrismaClient
  redis: Redis
  cache: SafeRedis
  config: AppConfig
  log: Logger
  validators: ValidatorCache
  rateLimiter: RateLimiter
}

export const DEFAULT_PLAYGROUND_RATE_PER_MIN = 30

// Long enough that a nonce is still remembered when the last request that could carry it expires
// (a timestamp is accepted from `window` in the past to `window` in the future).
const NONCE_TTL_SECONDS = Math.ceil((2 * PLAYGROUND_WINDOW_MS) / 1000)

const bodySchema = z.object({
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
  confirmed: z.boolean().optional(),
})

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' })
const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: 'unauthorized' })
const unavailable = (reply: FastifyReply) =>
  reply.code(503).send({ error: 'playground_unavailable', message: 'The playground is temporarily unavailable. Try again in a moment.' })

const header = (value: string | string[] | undefined): string => (typeof value === 'string' ? value : '')

/**
 * `POST /internal/playground/:projectSlug/run`: the dashboard runs one tool through the same upstream
 * call path as an MCP client (callUpstream) and gets back the masked request and response.
 *
 * Only registered when PLAYGROUND_SECRET is set. The dashboard has already checked that the signed-in
 * user owns the project; the gateway trusts that only because the request is signed. Nothing here
 * writes a call-log row. The replay check fails closed (Redis down means refused); the per-project
 * rate limit, like the API-key one, fails open.
 */
export function registerPlaygroundRoutes(app: FastifyInstance, deps: PlaygroundRouteDeps, secret: string): void {
  const limit = deps.config.playgroundRatePerMin ?? DEFAULT_PLAYGROUND_RATE_PER_MIN

  // The signature covers the exact body text, so this scope reads the body as a string and parses it itself.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
    scope.setErrorHandler((error: FastifyError, _request, reply) => {
      const status = error.statusCode ?? 500
      if (status === 413) return reply.code(413).send({ error: 'too_large' })
      return reply.code(status >= 400 && status < 500 ? 400 : 500).send({ error: status >= 500 ? 'internal' : 'invalid_request' })
    })

    scope.post<{ Params: { projectSlug: string }; Body: string }>('/internal/playground/:projectSlug/run', async (request, reply) => {
      const slug = request.params.projectSlug
      const rawBody = typeof request.body === 'string' ? request.body : ''
      const timestamp = Number(header(request.headers[PLAYGROUND_HEADERS.timestamp]))
      const nonce = header(request.headers[PLAYGROUND_HEADERS.nonce])
      const signature = header(request.headers[PLAYGROUND_HEADERS.signature])

      // The tool name is part of what was signed, so read it before checking (an unreadable body signs as '').
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        parsed = undefined
      }
      const toolName = typeof (parsed as { tool?: unknown } | undefined)?.tool === 'string' ? (parsed as { tool: string }).tool : ''

      // 1. Who signed it, and is it fresh.
      const verdict = verifyPlaygroundRequest(secret, { timestamp, nonce, slug, tool: toolName, body: rawBody }, signature)
      if (verdict !== 'ok') return unauthorized(reply)

      // 2. Has this nonce been used. Fails closed: if Redis cannot answer, the request is refused.
      try {
        const first = await deps.redis.set(`mcp:pg:nonce:${nonce}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX')
        if (first !== 'OK') return reply.code(401).send({ error: 'replayed' })
      } catch (err) {
        deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'playground refused: Redis could not check the nonce')
        return unavailable(reply)
      }

      // 3. The body.
      const body = bodySchema.safeParse(parsed)
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' })

      // 4. Project and tool. An unknown project, a disabled or removed tool and an unknown tool all look the same.
      let project
      try {
        project = await loadProjectConfig(slug, deps)
      } catch (err) {
        deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'playground could not load the project')
        return unavailable(reply)
      }
      const tool = project?.tools.find((t) => t.name === body.data.tool)
      if (!project || !tool) return notFound(reply)

      // 5. This calls the real upstream with the real credential: anything but a GET must be confirmed.
      if (tool.method.toUpperCase() !== 'GET' && body.data.confirmed !== true) {
        return reply.code(400).send({ error: 'confirmation_required', method: tool.method.toUpperCase(), path: tool.path })
      }

      // 6. Per-project limit, in its own key space.
      const decision = await deps.rateLimiter.check(`mcp:rl:playground:${project.projectId}`, limit)
      if (!decision.allowed) {
        return reply
          .code(429)
          .header('retry-after', decision.retryAfterSeconds)
          .send({ error: 'rate_limited', limit: decision.limit, retryAfterSeconds: decision.retryAfterSeconds })
      }

      // 7. The call. Only the masked preview goes back, never the MCP result text.
      const started = performance.now()
      const call = await callUpstream(project, tool, body.data.arguments, deps, { preview: true })
      const latencyMs = Math.round(performance.now() - started)
      const { outcome } = call

      // Project, tool and status only: no arguments, request, response or credential.
      deps.log.info(
        { projectId: project.projectId, tool: tool.name, upstreamStatus: outcome.upstreamStatus, isError: outcome.result.isError === true, latencyMs },
        'playground call'
      )

      return reply.send({
        ok: outcome.result.isError !== true,
        errorClass: outcome.errorClass ?? null,
        message: outcome.errorMessage ?? null,
        latencyMs,
        request: call.request ?? null,
        response: call.response ?? null,
      })
    })
  })
}
