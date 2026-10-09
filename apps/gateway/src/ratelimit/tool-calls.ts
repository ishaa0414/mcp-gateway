/**
 * Which part of a request counts against the rate limit: `tools/call` messages only.
 * The handshake (`initialize`, `notifications/initialized`) and `tools/list` repeat on every
 * stateless connection and never reach the upstream API, so counting them would spend a key's
 * quota on overhead. A JSON-RPC batch counts once per `tools/call` inside it.
 */
export interface ToolCallsInRequest {
  count: number
  /** The JSON-RPC id of the first counted call, echoed in a 429 so the client can match it. */
  firstId: string | number | null
}

const isToolCall = (m: unknown): m is { id?: unknown } =>
  typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call'

export function toolCallsIn(body: unknown): ToolCallsInRequest {
  const messages = Array.isArray(body) ? body : [body]
  const calls = messages.filter(isToolCall)
  const id = calls[0]?.id
  return { count: calls.length, firstId: typeof id === 'string' || typeof id === 'number' ? id : null }
}
