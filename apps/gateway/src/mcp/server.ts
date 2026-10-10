import { createMcpHandler, ProtocolError, Server } from '@modelcontextprotocol/server'
import type { Tool } from '@modelcontextprotocol/server'
import type { ProjectConfig } from '../cache/project-config.js'
import type { AppConfig, Logger } from '../config.js'
import type { CallLogger } from '../logging/call-logger.js'
import { annotationsForMethod } from './annotations.js'
import { executeTool, type ValidatorCache } from './call-tool.js'

/** Who is calling and for which project. Set by the route after authentication, read by the factory. */
export interface McpPrincipal {
  project: ProjectConfig
  apiKeyId: string
}

export interface McpDeps {
  config: AppConfig
  log: Logger
  validators: ValidatorCache
  callLog: CallLogger
}

const INVALID_PARAMS = -32602

/** One server per request, so nothing is shared between projects (or between calls of one project). */
function buildServer({ project, apiKeyId }: McpPrincipal, deps: McpDeps): Server {
  const server = new Server(
    { name: `mcp-gateway:${project.slug}`, version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler('tools/list', () => ({
    tools: project.tools.map(
      (t): Tool => ({
        name: t.name,
        description: t.description,
        inputSchema: t.agentSchema as Tool['inputSchema'],
        annotations: annotationsForMethod(t.method),
      })
    ),
  }))

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params
    const started = performance.now()
    const record = { projectId: project.projectId, apiKeyId, toolName: name, args }

    // Only enabled, non-removed tools are loaded, so a disabled tool is simply unknown.
    const tool = project.tools.find((t) => t.name === name)
    if (!tool) {
      deps.callLog.toolCall({ ...record, latencyMs: performance.now() - started, success: false, errorClass: 'UNKNOWN_TOOL', errorMessage: 'Unknown tool' })
      throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`)
    }

    let outcome
    try {
      outcome = await executeTool(project, tool, args, deps)
    } catch (err) {
      deps.callLog.toolCall({ ...record, tool, latencyMs: performance.now() - started, success: false, errorClass: 'INTERNAL', errorMessage: 'Internal error' })
      throw err
    }

    const latencyMs = performance.now() - started
    const success = outcome.result.isError !== true
    deps.callLog.toolCall({
      ...record,
      tool,
      latencyMs,
      success,
      errorClass: outcome.errorClass,
      errorMessage: outcome.errorMessage,
      upstreamStatus: outcome.upstreamStatus,
      responseBytes: outcome.responseBytes,
    })
    deps.log.info(
      {
        projectId: project.projectId,
        apiKeyId,
        tool: tool.name,
        upstreamStatus: outcome.upstreamStatus,
        isError: !success,
        latencyMs: Math.round(latencyMs),
      },
      'tool call'
    )
    return outcome.result
  })

  return server
}

/**
 * The SDK handler, built once. It does no authentication itself, so the route authenticates
 * first and passes the principal in through `authInfo.extra`.
 */
export function createGatewayHandler(deps: McpDeps) {
  return createMcpHandler(
    (ctx) => {
      const principal = ctx.authInfo?.extra?.['principal'] as McpPrincipal | undefined
      if (!principal) throw new Error('A request reached the MCP handler without an authenticated project')
      return buildServer(principal, deps)
    },
    { onerror: (err) => deps.log.warn({ err: err.message }, 'mcp handler error') }
  )
}
