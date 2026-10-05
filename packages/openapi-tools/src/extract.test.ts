import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpec } from './parse.js'
import { extractTools, sanitizeName, validateToolName } from './extract.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '__fixtures__')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadFixture(name: string): Promise<Record<string, any>> {
  const text = readFileSync(join(fixtures, name), 'utf-8')
  return parseSpec(text)
}

describe('sanitizeName', () => {
  it('keeps valid characters', () => {
    expect(sanitizeName('listPets')).toBe('listPets')
  })

  it('replaces spaces and slashes with underscores', () => {
    expect(sanitizeName('list /pets')).toBe('list__pets')
  })

  it('strips leading non-alpha characters', () => {
    expect(sanitizeName('_name')).toBe('_name') // underscore is valid first char
  })

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(80)
    expect(sanitizeName(long)).toHaveLength(64)
  })

  it('falls back to "tool" for empty result after strip', () => {
    // only digits → stripped → empty → 'tool'
    expect(sanitizeName('123')).toBe('tool')
  })
})

describe('validateToolName', () => {
  it('accepts valid names', () => {
    expect(validateToolName('listPets').valid).toBe(true)
    expect(validateToolName('get-user_v2').valid).toBe(true)
    expect(validateToolName('a').valid).toBe(true)
  })

  it('rejects names with spaces', () => {
    expect(validateToolName('list pets').valid).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateToolName('').valid).toBe(false)
  })

  it('rejects names longer than 64 chars', () => {
    expect(validateToolName('a'.repeat(65)).valid).toBe(false)
  })
})

describe('extractTools (petstore)', () => {
  it('extracts one tool per operation', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    expect(tools).toHaveLength(4)
  })

  it('uses operationId as name', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    const names = tools.map((t) => t.name)
    expect(names).toContain('listPets')
    expect(names).toContain('createPet')
    expect(names).toContain('showPetById')
  })

  it('generates a name from method+path when no operationId', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    const deleteTool = tools.find((t) => t.method === 'DELETE')
    expect(deleteTool).toBeDefined()
    expect(deleteTool!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('sets method and path correctly', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    const list = tools.find((t) => t.name === 'listPets')
    expect(list).toBeDefined()
    expect(list!.method).toBe('GET')
    expect(list!.path).toBe('/pets')
  })

  it('sets serversUrl on the first tool', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    expect(tools[0]?.serversUrl).toBe('https://petstore.example.com/v1')
    expect(tools[1]?.serversUrl).toBeUndefined()
  })

  it('includes requestBody parameters in inputSchema', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    const create = tools.find((t) => t.name === 'createPet')
    expect(create).toBeDefined()
    expect(create!.inputSchema.properties).toHaveProperty('name')
    expect(create!.inputSchema.required).toContain('name')
  })

  it('includes query parameters', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    const list = tools.find((t) => t.name === 'listPets')
    expect(list).toBeDefined()
    expect(list!.inputSchema.properties).toHaveProperty('limit')
    expect(list!.inputSchema.required ?? []).not.toContain('limit')
  })

  it('all generated names match MCP regex', async () => {
    const doc = await loadFixture('petstore.json')
    const tools = extractTools(doc)
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  })
})

describe('extractTools (complex yaml)', () => {
  it('handles path-level parameters (inherited by operations)', async () => {
    const doc = await loadFixture('complex.yaml')
    const tools = extractTools(doc)
    const getUser = tools.find((t) => t.name === 'getUser')
    expect(getUser).toBeDefined()
    expect(getUser!.inputSchema.properties).toHaveProperty('userId')
    expect(getUser!.inputSchema.required).toContain('userId')
  })

  it('includes enum in schema', async () => {
    const doc = await loadFixture('complex.yaml')
    const tools = extractTools(doc)
    const list = tools.find((t) => t.name === 'listUsers')
    expect(list).toBeDefined()
    const roleProp = list!.inputSchema.properties?.['role'] as { enum?: unknown[] } | undefined
    expect(roleProp?.enum).toEqual(['admin', 'user', 'guest'])
  })

  it('handles array type in requestBody', async () => {
    const doc = await loadFixture('complex.yaml')
    const tools = extractTools(doc)
    const update = tools.find((t) => t.name === 'updateUser')
    expect(update).toBeDefined()
    const tagsProp = update!.inputSchema.properties?.['tags'] as { type: string } | undefined
    expect(tagsProp?.type).toBe('array')
  })

  it('generates name for operation without operationId', async () => {
    const doc = await loadFixture('complex.yaml')
    const tools = extractTools(doc)
    const post = tools.find((t) => t.method === 'POST' && t.path === '/items')
    expect(post).toBeDefined()
    expect(post!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('ensures no duplicate names', async () => {
    const doc = await loadFixture('complex.yaml')
    const tools = extractTools(doc)
    const names = tools.map((t) => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})
