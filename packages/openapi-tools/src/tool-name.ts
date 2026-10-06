// Kept free of Node/parser imports so client components can validate as you type
// via the "@mcp-gateway/openapi-tools/tool-name" subpath.

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/** Validate a proposed MCP tool name and say what is wrong with it. */
export function validateToolName(name: string): { valid: boolean; error?: string } {
  if (name.length === 0) {
    return { valid: false, error: 'Tool name is required.' }
  }
  if (name.length > 64) {
    return { valid: false, error: `Tool name is ${name.length} characters; the maximum is 64.` }
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    const bad = [...new Set(name.match(/[^a-zA-Z0-9_-]/g))]
      .map((c) => (c === ' ' ? 'spaces' : `"${c}"`))
      .join(', ')
    return {
      valid: false,
      error:
        `Tool name can't contain ${bad}. MCP clients only accept letters, numbers, ` +
        `underscores and hyphens (for example "find_pet").`,
    }
  }
  return { valid: true }
}

/** Shown by both the live check in the editor and the server, so they cannot drift apart. */
export function toolNameTakenMessage(name: string): string {
  return `Another tool in this project is already named "${name}". Tool names must be unique.`
}
