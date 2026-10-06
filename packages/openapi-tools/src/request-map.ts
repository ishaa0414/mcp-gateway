import { isRef, schemaToJsonSchema } from './schema.js'
import type { ArgBinding, ArgLocation, JsonSchema, RequestMap } from './types.js'

/** One argument of a tool: its schema as the agent sees it, plus where it goes on the wire. */
export interface OperationArg {
  binding: ArgBinding
  schema: JsonSchema
  required: boolean
}

export interface OperationDescription {
  args: OperationArg[]
  bodyContentType?: 'json' | 'form'
}

// Path parameters keep their plain names and win clashes; the rest are renamed.
const LOCATION_ORDER = ['path', 'query', 'header', 'cookie'] as const
type ParamLocation = (typeof LOCATION_ORDER)[number]

const PREFIX: Record<ArgLocation, string> = {
  path: 'path',
  query: 'query',
  header: 'header',
  cookie: 'cookie',
  body: 'body',
  bodyRoot: 'request_body',
}

interface Candidate {
  location: ArgLocation
  wire: string
  schema: JsonSchema
  required: boolean
  explode?: boolean
  /** The name to try first (the wire name, or "body" for a whole-body argument). */
  preferred: string
}

type Loose = Record<string, unknown>

function collectParameters(pathItem: Loose, op: Loose): Candidate[] {
  // An operation-level parameter replaces a path-level one with the same name AND location.
  const byKey = new Map<string, Loose>()
  for (const list of [pathItem['parameters'], op['parameters']]) {
    if (!Array.isArray(list)) continue
    for (const p of list as unknown[]) {
      if (isRef(p) || typeof p !== 'object' || p === null) continue
      const param = p as Loose
      if (typeof param['name'] !== 'string') continue
      if (!(LOCATION_ORDER as readonly unknown[]).includes(param['in'])) continue
      byKey.set(`${String(param['in'])}:${param['name']}`, param)
    }
  }

  const out: Candidate[] = []
  for (const location of LOCATION_ORDER) {
    for (const param of byKey.values()) {
      if (param['in'] !== location) continue
      const name = param['name'] as string
      out.push({
        location: location as ParamLocation,
        wire: name,
        preferred: name,
        schema: schemaToJsonSchema(param['schema'] as Loose | undefined),
        // OpenAPI makes path parameters mandatory whatever `required` says.
        required: location === 'path' ? true : ((param['required'] as boolean | undefined) ?? false),
        ...(location === 'query' && typeof param['explode'] === 'boolean' ? { explode: param['explode'] } : {}),
      })
    }
  }
  return out
}

function collectBody(requestBody: unknown): { candidates: Candidate[]; contentType?: 'json' | 'form' } {
  if (!requestBody || isRef(requestBody) || typeof requestBody !== 'object') return { candidates: [] }
  const content = (requestBody as Loose)['content'] as Record<string, Loose> | undefined
  const json = content?.['application/json']
  const form = content?.['application/x-www-form-urlencoded']
  const media = json ?? form
  if (!media) return { candidates: [] }
  const contentType = json ? 'json' : 'form'

  const schema = media['schema'] as Loose | undefined
  if (!schema || isRef(schema)) return { candidates: [] }

  if (schema['type'] === 'object' || schema['properties']) {
    const props = (schema['properties'] as Record<string, unknown> | undefined) ?? {}
    const required = (schema['required'] as string[] | undefined) ?? []
    return {
      contentType,
      candidates: Object.entries(props).map(([name, val]) => ({
        location: 'body' as const,
        wire: name,
        preferred: name,
        schema: isRef(val) ? { type: 'string' } : schemaToJsonSchema(val as Loose),
        required: required.includes(name),
      })),
    }
  }

  // An array or primitive body is a single argument holding the whole body.
  return {
    contentType,
    candidates: [
      {
        location: 'bodyRoot',
        wire: 'body',
        preferred: 'body',
        schema: schemaToJsonSchema(schema),
        required: ((requestBody as Loose)['required'] as boolean | undefined) ?? false,
      },
    ],
  }
}

function uniqueArgName(c: Candidate, used: Set<string>): string {
  // A whole-body argument has no wire name, so its fallback is just the prefix.
  const fallback = c.location === 'bodyRoot' ? PREFIX.bodyRoot : `${PREFIX[c.location]}_${c.wire}`
  const attempts = [c.preferred, fallback]
  for (const name of attempts) {
    if (!used.has(name)) return name
  }
  const base = attempts[1]!
  for (let n = 2; ; n++) {
    const name = `${base}_${n}`
    if (!used.has(name)) return name
  }
}

/**
 * The single description of an operation's arguments. It is used both to build the tool's
 * input schema (extractTools) and to map a call's arguments back onto the HTTP request
 * (buildRequestMap), so the two cannot drift apart.
 *
 * Previously arguments were keyed by name alone, so a path parameter `id` and a body field
 * `id` silently overwrote each other. Now the first one (path, query, header, cookie, then
 * body) keeps its name and a later clash is renamed with its location, e.g. `body_id`.
 */
export function describeOperation(pathItem: Loose, op: Loose): OperationDescription {
  const body = collectBody(op['requestBody'])
  const candidates = [...collectParameters(pathItem, op), ...body.candidates]

  const used = new Set<string>()
  const args: OperationArg[] = candidates.map((c) => {
    const arg = uniqueArgName(c, used)
    used.add(arg)
    return {
      binding: { arg, in: c.location, name: c.wire, ...(c.explode !== undefined ? { explode: c.explode } : {}) },
      schema: c.schema,
      required: c.required,
    }
  })

  return { args, ...(body.contentType ? { bodyContentType: body.contentType } : {}) }
}

/** The request map for one operation of a (dereferenced) OpenAPI document, or null if it is not there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildRequestMap(doc: Record<string, any>, method: string, path: string): RequestMap | null {
  const pathItem = doc['paths']?.[path] as Loose | undefined
  const op = pathItem?.[method.toLowerCase()] as Loose | undefined
  if (!pathItem || !op) return null

  const { args, bodyContentType } = describeOperation(pathItem, op)
  return { bindings: args.map((a) => a.binding), ...(bodyContentType ? { bodyContentType } : {}) }
}
