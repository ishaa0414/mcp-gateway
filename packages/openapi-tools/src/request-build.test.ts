import { describe, expect, it } from 'vitest'
import { buildRequest, RequestBuildError } from './request-build.js'
import type { ArgBinding, RequestMap } from './types.js'

const BASE = 'https://api.example.com/v1'

function build(
  bindings: ArgBinding[],
  args: Record<string, unknown>,
  opts: { method?: string; path?: string; bodyContentType?: RequestMap['bodyContentType']; baseUrl?: string } = {}
) {
  return buildRequest({
    baseUrl: opts.baseUrl ?? BASE,
    method: opts.method ?? 'GET',
    path: opts.path ?? '/things',
    map: { bindings, ...(opts.bodyContentType ? { bodyContentType: opts.bodyContentType } : {}) },
    args,
  })
}

const path = (arg: string, name = arg): ArgBinding => ({ arg, in: 'path', name })
const query = (arg: string, name = arg, explode?: boolean): ArgBinding => ({
  arg,
  in: 'query',
  name,
  ...(explode !== undefined ? { explode } : {}),
})
const header = (arg: string, name = arg): ArgBinding => ({ arg, in: 'header', name })
const body = (arg: string, name = arg): ArgBinding => ({ arg, in: 'body', name })

describe('URL assembly', () => {
  it('joins base URL, path and query', () => {
    const r = build([path('petId'), query('verbose')], { petId: 7, verbose: true }, { path: '/pets/{petId}' })
    expect(r.url).toBe('https://api.example.com/v1/pets/7?verbose=true')
    expect(r.method).toBe('GET')
  })

  it('does not double the slash when the base URL ends with one', () => {
    expect(build([], {}, { baseUrl: 'https://api.example.com/v1/', path: '/things' }).url).toBe(
      'https://api.example.com/v1/things'
    )
  })

  it('fills several placeholders and uses the wire name, not the argument name', () => {
    const r = build([path('owner_id', 'owner'), path('petId')], { owner_id: 'ann', petId: 3 }, { path: '/owners/{owner}/pets/{petId}' })
    expect(r.url).toBe('https://api.example.com/v1/owners/ann/pets/3')
  })

  it('percent-encodes path values, including slashes', () => {
    const r = build([path('name')], { name: 'a b/c?d#e' }, { path: '/x/{name}' })
    expect(r.url).toBe('https://api.example.com/v1/x/a%20b%2Fc%3Fd%23e')
  })

  it.each(['..', '.', ''])('rejects the path value %j, which would climb out of the path', (value) => {
    expect(() => build([path('id')], { id: value }, { path: '/x/{id}' })).toThrow(RequestBuildError)
  })

  it('keeps an encoded traversal attempt harmless', () => {
    const r = build([path('id')], { id: '../admin' }, { path: '/x/{id}' })
    expect(r.url).toBe('https://api.example.com/v1/x/..%2Fadmin')
  })

  it('fails clearly when a path value is missing or null', () => {
    expect(() => build([path('petId')], {}, { path: '/pets/{petId}' })).toThrow(/Missing required path parameter "petId"/)
    expect(() => build([path('petId')], { petId: null }, { path: '/pets/{petId}' })).toThrow(RequestBuildError)
  })

  it('fails when the template has a placeholder no argument is bound to', () => {
    expect(() => build([], {}, { path: '/pets/{petId}' })).toThrow(/petId/)
  })
})

describe('query parameters', () => {
  it('skips undefined and null, and encodes names and values', () => {
    const r = build([query('a'), query('b'), query('c'), query('q', 'search term')], { a: undefined, b: null, c: 'x y&z', q: 'é' })
    expect(r.url).toBe('https://api.example.com/v1/things?c=x%20y%26z&search%20term=%C3%A9')
  })

  it('repeats the key for arrays by default (explode)', () => {
    expect(build([query('tag')], { tag: ['a', 'b'] }).url).toBe('https://api.example.com/v1/things?tag=a&tag=b')
  })

  it('joins arrays with commas when explode is false', () => {
    expect(build([query('tag', 'tag', false)], { tag: ['a', 'b'] }).url).toBe('https://api.example.com/v1/things?tag=a%2Cb')
  })

  it('sends objects as JSON, and keeps false and 0', () => {
    const r = build([query('filter'), query('on'), query('n')], { filter: { a: 1 }, on: false, n: 0 })
    expect(r.url).toBe('https://api.example.com/v1/things?filter=%7B%22a%22%3A1%7D&on=false&n=0')
  })
})

describe('headers and cookies', () => {
  it('sets headers from arguments, lower-cased', () => {
    const r = build([header('trace', 'X-Trace-Id')], { trace: 'abc' })
    expect(r.headers['x-trace-id']).toBe('abc')
    expect(r.headers['accept']).toBeDefined()
  })

  it('lets an Accept header argument override the default', () => {
    expect(build([header('accept', 'Accept')], { accept: 'text/csv' }).headers['accept']).toBe('text/csv')
  })

  it.each(['a\r\nX-Injected: 1', 'a\nb', 'a\0b'])('rejects a header value containing a control character (%j)', (value) => {
    expect(() => build([header('h', 'X-H')], { h: value })).toThrow(/header "X-H"/)
  })

  it('collects cookie parameters into one Cookie header', () => {
    const r = build(
      [
        { arg: 'sid', in: 'cookie', name: 'sid' },
        { arg: 'theme', in: 'cookie', name: 'theme' },
      ],
      { sid: 'a b', theme: 'dark' }
    )
    expect(r.headers['cookie']).toBe('sid=a%20b; theme=dark')
  })
})

describe('request bodies', () => {
  it('assembles a JSON object from body arguments, mapping argument names back to wire names', () => {
    const r = build([body('name'), body('body_id', 'id'), body('tags')], { name: 'Rex', body_id: 'x1', tags: ['a'] }, {
      method: 'POST',
      bodyContentType: 'json',
    })

    expect(JSON.parse(r.body!)).toEqual({ name: 'Rex', id: 'x1', tags: ['a'] })
    expect(r.headers['content-type']).toBe('application/json')
  })

  it('keeps explicit nulls and falsy values but drops undefined', () => {
    const r = build([body('a'), body('b'), body('c'), body('d')], { a: null, b: 0, c: false, d: undefined }, {
      method: 'PUT',
      bodyContentType: 'json',
    })
    expect(JSON.parse(r.body!)).toEqual({ a: null, b: 0, c: false })
  })

  it('omits the body when no body argument has a value', () => {
    const r = build([body('a')], {}, { method: 'POST', bodyContentType: 'json' })
    expect(r.body).toBeUndefined()
    expect(r.headers['content-type']).toBeUndefined()
  })

  it('sends a whole-body argument as the body', () => {
    const r = build([{ arg: 'body', in: 'bodyRoot', name: 'body' }], { body: [1, 2, 3] }, { method: 'POST', bodyContentType: 'json' })
    expect(r.body).toBe('[1,2,3]')
  })

  it('encodes form bodies', () => {
    const r = build([body('a'), body('tags'), body('o')], { a: 'x y', tags: ['p', 'q'], o: { k: 1 } }, {
      method: 'POST',
      bodyContentType: 'form',
    })
    expect(r.body).toBe('a=x+y&tags=p&tags=q&o=%7B%22k%22%3A1%7D')
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded')
  })

  it.each(['GET', 'DELETE', 'HEAD'])('refuses a body on %s', (method) => {
    expect(() => build([body('a')], { a: 1 }, { method, bodyContentType: 'json' })).toThrow(/cannot carry a request body/)
  })

  it('allows PATCH', () => {
    expect(build([body('a')], { a: 1 }, { method: 'patch', bodyContentType: 'json' }).method).toBe('PATCH')
  })
})

describe('does not invent data', () => {
  it('ignores arguments that no binding mentions', () => {
    const r = build([query('a')], { a: 1, secret: 'nope', 'x-admin': 'yes' })
    expect(r.url).toBe('https://api.example.com/v1/things?a=1')
    expect(JSON.stringify(r)).not.toContain('nope')
  })
})
