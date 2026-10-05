import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpec, ParseError } from './parse.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '__fixtures__')

describe('parseSpec', () => {
  it('parses a valid OpenAPI 3.0 JSON spec', async () => {
    const input = readFileSync(join(fixtures, 'petstore.json'), 'utf-8')
    const doc = await parseSpec(input)
    expect(doc['openapi']).toMatch(/^3\./)
    expect(doc['info']?.['title']).toBe('Petstore')
  })

  it('parses a valid OpenAPI 3.1 YAML spec', async () => {
    const input = readFileSync(join(fixtures, 'complex.yaml'), 'utf-8')
    const doc = await parseSpec(input)
    expect(doc['openapi']).toBe('3.1.0')
  })

  it('parses a Buffer input', async () => {
    const buf = readFileSync(join(fixtures, 'petstore.json'))
    const doc = await parseSpec(buf)
    expect(doc['info']?.['version']).toBe('1.0.0')
  })

  it('throws ParseError for invalid JSON', async () => {
    await expect(parseSpec('{not valid json')).rejects.toThrow(ParseError)
  })

  it('throws ParseError for swagger 2.0', async () => {
    const swagger2 = JSON.stringify({
      swagger: '2.0',
      info: { title: 'Old', version: '1.0' },
      paths: {},
    })
    await expect(parseSpec(swagger2)).rejects.toThrow(ParseError)
  })

  it('throws ParseError for non-object input', async () => {
    await expect(parseSpec('"just a string"')).rejects.toThrow(ParseError)
  })
})
