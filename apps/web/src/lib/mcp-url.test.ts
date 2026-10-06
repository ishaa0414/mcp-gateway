import { describe, expect, it } from 'vitest'
import { mcpEndpointUrl } from './mcp-url'

describe('mcpEndpointUrl', () => {
  it('builds the full URL from the gateway base and the slug', () => {
    expect(mcpEndpointUrl('http://localhost:4000', 'petstore')).toBe('http://localhost:4000/mcp/petstore')
  })

  it('tolerates trailing slashes on the base URL', () => {
    expect(mcpEndpointUrl('https://gw.example.com/', 'a')).toBe('https://gw.example.com/mcp/a')
    expect(mcpEndpointUrl('https://gw.example.com///', 'a')).toBe('https://gw.example.com/mcp/a')
  })

  it('keeps a path prefix the gateway is mounted under', () => {
    expect(mcpEndpointUrl('https://example.com/gateway', 'a')).toBe('https://example.com/gateway/mcp/a')
  })

  it('encodes the slug defensively', () => {
    expect(mcpEndpointUrl('http://x', 'a b/c')).toBe('http://x/mcp/a%20b%2Fc')
  })
})
