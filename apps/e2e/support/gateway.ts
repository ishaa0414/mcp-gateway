import { FIXTURE_URL, GATEWAY_URL } from './environment'

export interface RpcReply {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

/**
 * One JSON-RPC call to the gateway's /mcp endpoint, with the key as a Bearer token. The gateway is stateless, so no
 * handshake is needed. It answers either plain JSON or a one-event stream; both are read the same way.
 */
export async function callGateway(slug: string, apiKey: string, method: string, params?: object): Promise<RpcReply> {
  const res = await fetch(`${GATEWAY_URL}/mcp/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })
  const text = await res.text()
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length)
  return { status: res.status, body: JSON.parse(data ?? text) }
}

export interface UpstreamRequest {
  method: string
  url: string
  accept: string | undefined
}

/** What the fixture upstream has received so far (the gateway has answered, so the requests are already recorded). */
export async function upstreamRequests(): Promise<UpstreamRequest[]> {
  return (await fetch(`${FIXTURE_URL}/__requests`)).json() as Promise<UpstreamRequest[]>
}
