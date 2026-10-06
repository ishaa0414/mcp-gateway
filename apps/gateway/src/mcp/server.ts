import { createMcpHandler, ProtocolError, Server } from '@modelcontextprotocol/server'
import type { Tool } from '@modelcontextprotocol/server'
import type { ProjectConfig } from '../cache/project-config.js'
import type { AppConfig, Logger } from '../config.js'
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
      })
    ),
  }))

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params

    // Only enabled, non-removed tools are loaded, so a disabled tool is simply unknown.
    const tool = project.tools.find((t) => t.name === name)
    if (!tool) throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`)

    const started = performance.now()
    const outcome = await executeTool(project, tool, args, deps)
    deps.log.info(
      {
        projectId: project.projectId,
        apiKeyId,
        tool: tool.name,
        upstreamStatus: outcome.upstreamStatus,
        isError: outcome.result.isError === true,
        latencyMs: Math.round(performance.now() - started),
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
