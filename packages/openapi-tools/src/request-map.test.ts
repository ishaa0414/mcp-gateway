import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpec } from './parse.js'
import { extractTools } from './extract.js'
import { buildRequestMap, describeOperation } from './request-map.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const load = (name: string) => parseSpec(readFileSync(join(fixtures, name), 'utf-8'))

const str = { type: 'string' }
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})
const json = (schema: unknown, required = false) => ({ required, content: { 'application/json': { schema } } })

/** Names of an operation's arguments, in order. */
const argNames = (pathItem: Record<string, unknown>, op: Record<string, unknown>) => describeOperation(pathItem, op).args.map((a) => a.binding.arg)
const bindingOf = (pathItem: Record<string, unknown>, op: Record<string, unknown>, arg: string) =>
  describeOperation(pathItem, op).args.find((a) => a.binding.arg === arg)?.binding

describe('describeOperation: locations', () => {
  const op = {
    parameters: [
      { name: 'petId', in: 'path', schema: { type: 'integer' } },
      { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
      { name: 'tags', in: 'query', explode: false, schema: { type: 'array', items: str } },
      { name: 'X-Trace', in: 'header', schema: str },
      { name: 'session', in: 'cookie', schema: str },
    ],
    requestBody: json(obj({ name: str, age: { type: 'integer' } }, ['name'])),
  }

  it('binds every argument to where it goes on the wire', () => {
    const { args, bodyContentType } = describeOperation({}, op)

    expect(args.map((a) => a.binding)).toEqual([
      { arg: 'petId', in: 'path', name: 'petId' },
      { arg: 'limit', in: 'query', name: 'limit' },
      { arg: 'tags', in: 'query', name: 'tags', explode: false },
      { arg: 'X-Trace', in: 'header', name: 'X-Trace' },
      { arg: 'session', in: 'cookie', name: 'session' },
      { arg: 'name', in: 'body', name: 'name' },
      { arg: 'age', in: 'body', name: 'age' },
    ])
    expect(bodyContentType).toBe('json')
  })

  it('makes path parameters required whatever the spec says, and honours required elsewhere', () => {
    const required = Object.fromEntries(describeOperation({}, op).args.map((a) => [a.binding.arg, a.required]))
    expect(required).toEqual({
      petId: true,
      limit: true,
      tags: false,
      'X-Trace': false,
      session: false,
      name: true,
      age: false,
    })
  })

  it('treats a form body as form', () => {
    const form = { requestBody: { content: { 'application/x-www-form-urlencoded': { schema: obj({ a: str }) } } } }
    expect(describeOperation({}, form).bodyContentType).toBe('form')
  })

  it('prefers JSON when both are offered', () => {
    const both = {
      requestBody: {
        content: {
          'application/x-www-form-urlencoded': { schema: obj({ f: str }) },
          'application/json': { schema: obj({ j: str }) },
        },
      },
    }
    expect(argNames({}, both)).toEqual(['j'])
  })

  it('offers no body argument for unsupported media types', () => {
    const multipart = { requestBody: { content: { 'multipart/form-data': { schema: obj({ file: str }) } } } }
    expect(describeOperation({}, multipart).args).toEqual([])
  })

  it('makes an array or primitive body one argument holding the whole body', () => {
    const op2 = { requestBody: json({ type: 'array', items: str }, true) }
    const { args } = describeOperation({}, op2)
    expect(args).toHaveLength(1)
    expect(args[0]).toMatchObject({ binding: { arg: 'body', in: 'bodyRoot' }, required: true })
  })

  it('ignores parameters with an unknown location', () => {
    expect(argNames({}, { parameters: [{ name: 'x', in: 'matrix', schema: str }] })).toEqual([])
  })
})

describe('describeOperation: path-level and operation-level parameters', () => {
  it('inherits path-level parameters', () => {
    const pathItem = { parameters: [{ name: 'tenant', in: 'path', schema: str }] }
    expect(argNames(pathItem, { parameters: [{ name: 'q', in: 'query', schema: str }] })).toEqual(['tenant', 'q'])
  })

  it('lets an operation-level parameter replace the path-level one with the same name and location', () => {
    const pathItem = { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }] }
    const op = { parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'string' } }] }

    const { args } = describeOperation(pathItem, op)

    expect(args).toHaveLength(1)
    expect(args[0]).toMatchObject({ required: true, schema: { type: 'string' } })
  })

  it('keeps same-named parameters in different locations as separate arguments', () => {
    const op = {
      parameters: [
        { name: 'id', in: 'path', schema: str },
        { name: 'id', in: 'query', schema: str },
      ],
    }
    expect(argNames({}, op)).toEqual(['id', 'query_id'])
  })
})

describe('describeOperation: name clashes', () => {
  it('keeps the path parameter name and renames the body field that clashes (the old silent overwrite)', () => {
    const op = {
      parameters: [{ name: 'id', in: 'path', schema: { type: 'integer' } }],
      requestBody: json(obj({ id: str, name: str })),
    }

    expect(argNames({}, op)).toEqual(['id', 'body_id', 'name'])
    expect(bindingOf({}, op, 'id')).toMatchObject({ in: 'path', name: 'id' })
    expect(bindingOf({}, op, 'body_id')).toMatchObject({ in: 'body', name: 'id' })
  })

  it('resolves a clash across every location, in a fixed order', () => {
    const op = {
      parameters: [
        { name: 'id', in: 'cookie', schema: str },
        { name: 'id', in: 'header', schema: str },
        { name: 'id', in: 'query', schema: str },
        { name: 'id', in: 'path', schema: str },
      ],
      requestBody: json(obj({ id: str })),
    }

    // Declaration order does not matter: path > query > header > cookie > body.
    expect(argNames({}, op)).toEqual(['id', 'query_id', 'header_id', 'cookie_id', 'body_id'])
  })

  it('never produces a duplicate name, even when a renamed one is already taken', () => {
    const op = {
      parameters: [
        { name: 'id', in: 'path', schema: str },
        { name: 'body_id', in: 'query', schema: str },
      ],
      requestBody: json(obj({ id: str })),
    }

    const names = argNames({}, op)

    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(['id', 'body_id', 'body_id_2'])
  })

  it('renames a whole-body argument that clashes with a parameter called body', () => {
    const op = {
      parameters: [{ name: 'body', in: 'query', schema: str }],
      requestBody: json({ type: 'array', items: str }),
    }
    expect(argNames({}, op)).toEqual(['body', 'request_body'])
  })

  it('is deterministic', () => {
    const op = {
      parameters: [
        { name: 'id', in: 'query', schema: str },
        { name: 'id', in: 'path', schema: str },
      ],
      requestBody: json(obj({ id: str })),
    }
    expect(describeOperation({}, op)).toEqual(describeOperation({}, op))
  })
})

describe('buildRequestMap', () => {
  it('describes an operation of a real spec', async () => {
    const doc = await load('petstore.json')
    const map = buildRequestMap(doc, 'GET', '/pets/{petId}')

    expect(map?.bindings).toContainEqual({ arg: 'petId', in: 'path', name: 'petId' })
  })

  it('is case-insensitive about the method and returns null for unknown operations', async () => {
    const doc = await load('petstore.json')
    expect(buildRequestMap(doc, 'get', '/pets/{petId}')).not.toBeNull()
    expect(buildRequestMap(doc, 'GET', '/nope')).toBeNull()
    expect(buildRequestMap(doc, 'PATCH', '/pets/{petId}')).toBeNull()
  })

  it.each(['petstore.json', 'complex.yaml'])(
    'agrees exactly with the tool schema for every operation in %s (no drift)',
    async (file) => {
      const doc = await load(file)
      const tools = extractTools(doc)
      expect(tools.length).toBeGreaterThan(0)

      for (const tool of tools) {
        const map = buildRequestMap(doc, tool.method, tool.path)
        expect(map, `${tool.method} ${tool.path}`).not.toBeNull()

        const schemaArgs = Object.keys(tool.inputSchema.properties ?? {}).sort()
        const mappedArgs = map!.bindings.map((b) => b.arg).sort()
        expect(mappedArgs, `${tool.method} ${tool.path}`).toEqual(schemaArgs)
      }
    }
  )
})

describe('extractTools after the clash fix', () => {
  it('no longer lets a body field overwrite a path parameter of the same name', () => {
    const doc = {
      paths: {
        '/things/{id}': {
          put: {
            operationId: 'updateThing',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
            requestBody: json(obj({ id: { type: 'string' }, name: str }, ['name'])),
          },
        },
      },
    }

    const [tool] = extractTools(doc)

    expect(Object.keys(tool!.inputSchema.properties!)).toEqual(['id', 'body_id', 'name'])
    expect(tool!.inputSchema.properties!['id']).toEqual({ type: 'integer' })
    expect(tool!.inputSchema.required).toEqual(['id', 'name'])
  })
})
