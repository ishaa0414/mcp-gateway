/**
 * Phase 2 spike: the smallest multi-tenant-shaped MCP server on the current SDK.
 *
 *   pnpm --filter @mcp-gateway/gateway exec tsx examples/spike-server.ts
 *   npx @modelcontextprotocol/inspector     # Streamable HTTP -> http://localhost:4100/mcp/demo
 *
 * See examples/README.md for what this taught us.
 */
import Fastify from 'fastify'
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

// Hard-coded stand-ins for what the gateway will load per project.
const TOOLS: Tool[] = [
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'echo',
    description: 'Echo a message back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
]

/** A new Server per HTTP request: stateless, so nothing is shared between tenants. */
function buildServer(slug: string): Server {
  const server = new Server({ name: `spike-${slug}`, version: '0.0.1' }, { capabilities: { tools: {} } })

  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }))

  server.setRequestHandler('tools/call', (request) => {
    const { name, arguments: args = {} } = request.params
    switch (name) {
      case 'add':
        return { content: [{ type: 'text', text: String(Number(args['a']) + Number(args['b'])) }] }
      case 'echo':
        return { content: [{ type: 'text', text: String(args['message']) }] }
      default:
        // A tool failure is a result with isError, not a protocol error.
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    }
  })

  return server
}

const app = Fastify({ logger: false })

// Shows which protocol revision each client speaks (the header is absent on 2025 `initialize`).
app.addHook('preHandler', async (request) => {
  const body = request.body as { method?: string; params?: { protocolVersion?: string } } | undefined
  console.log(
    `${request.method} ${request.url}  rpc=${body?.method ?? '-'}`,
    `mcp-protocol-version=${request.headers['mcp-protocol-version'] ?? '-'}`,
    body?.params?.protocolVersion ? `initialize.protocolVersion=${body.params.protocolVersion}` : ''
  )
})

app.route({
  method: ['POST'],
  url: '/mcp/:slug',
  handler: async (request, reply) => {
    const { slug } = request.params as { slug: string }
    // The factory has to be built per request because it closes over the slug.
    const handler = createMcpHandler(() => buildServer(slug))
    reply.hijack() // the SDK writes the raw response itself
    await toNodeHandler(handler)(request.raw, reply.raw, request.body)
  },
})

const port = Number(process.env['SPIKE_PORT'] ?? 4100)
await app.listen({ port, host: '127.0.0.1' })
console.log(`spike MCP server on http://127.0.0.1:${port}/mcp/demo`)
