import type { ToolAnnotations } from '@modelcontextprotocol/server'

/**
 * MCP tool annotations derived from the upstream HTTP method, so clients can tell a
 * lookup from a delete. Without them a client must assume the worst (destructive).
 * These are hints for UIs, not security controls.
 *
 * | method        | read-only | destructive | idempotent |
 * | GET, HEAD     | yes       | no          | (n/a)      |
 * | PUT           | no        | no          | yes        |
 * | DELETE        | no        | yes         | yes        |
 * | POST, PATCH   | no        | no          | no         |
 *
 * Every tool talks to an external API, so openWorldHint is always true.
 */
export function annotationsForMethod(method: string): ToolAnnotations {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    case 'PUT':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    default: // POST, PATCH, and anything unexpected: assume it changes state, and may repeat its effect
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
}
