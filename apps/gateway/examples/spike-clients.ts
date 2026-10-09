/**
 * Drives spike-server.ts with both SDK generations, to see which protocol each one
 * negotiates and that both can list and call tools.
 *
 *   pnpm --filter @mcp-gateway/gateway exec tsx examples/spike-clients.ts [url]
 */
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:4100/mcp/demo')
const headers = { Authorization: 'Bearer spike-key' }

// mode: 'legacy' (the default) speaks the 2025 handshake; 'auto' probes for 2026-07-28 and falls back.
async function viaV2(mode: 'legacy' | 'auto' | { pin: string }) {
  const client = new ClientV2({ name: 'spike-v2', version: '0.0.1' }, { versionNegotiation: { mode } })
  await client.connect(new TransportV2(url, { requestInit: { headers } }))
  const tools = await client.listTools()
  const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 40 } })
  console.log(`v2 client (${JSON.stringify(mode)})  tools:`, tools.tools.map((t) => t.name), ' add(2,40) ->', JSON.stringify(result.content))
  await client.close()
}

async function viaV1() {
  const client = new ClientV1({ name: 'spike-v1', version: '0.0.1' })
  await client.connect(new TransportV1(url, { requestInit: { headers } }))
  const tools = await client.listTools()
  const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 40 } })
  console.log('v1 client  tools:', tools.tools.map((t) => t.name), ' add(2,40) ->', JSON.stringify(result.content))
  await client.close()
}

await viaV2('legacy')
await viaV2('auto')
await viaV2({ pin: '2026-07-28' })
await viaV1()
