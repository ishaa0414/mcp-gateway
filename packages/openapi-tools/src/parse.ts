import SwaggerParser from '@apidevtools/swagger-parser'
import { parse as parseYaml } from 'yaml'

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

/**
 * Parse and validate an OpenAPI 3.0 or 3.1 spec from a string or Buffer.
 * Returns the fully dereferenced document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseSpec(input: string | Buffer): Promise<Record<string, any>> {
  const text = typeof input === 'string' ? input : input.toString('utf-8')

  let raw: unknown
  const trimmed = text.trimStart()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ParseError('Failed to parse JSON: invalid JSON syntax')
    }
  } else {
    try {
      raw = parseYaml(text)
    } catch (e: unknown) {
      throw new ParseError(`Failed to parse YAML: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError('Spec must be a JSON/YAML object')
  }

  const doc = raw as Record<string, unknown>

  const version = (doc['openapi'] as string | undefined) ?? ''
  if (!version.startsWith('3.')) {
    throw new ParseError(
      `Only OpenAPI 3.0.x and 3.1.x are supported (got "${version || 'unknown'}")`
    )
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = await SwaggerParser.dereference(raw as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return api as Record<string, any>
  } catch (e: unknown) {
    throw new ParseError(
      `OpenAPI validation failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
