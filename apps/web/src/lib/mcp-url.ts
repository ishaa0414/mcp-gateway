/** The full MCP endpoint a client connects to: the gateway's public base URL plus /mcp/<slug>. */
export function mcpEndpointUrl(gatewayBaseUrl: string, slug: string): string {
  return `${gatewayBaseUrl.replace(/\/+$/, '')}/mcp/${encodeURIComponent(slug)}`
}
