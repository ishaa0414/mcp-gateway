/**
 * The analytics seed writes VALIDATION rows with the gateway's error wording. This keeps the two
 * in step: the seed's message must equal what the gateway's real validator says about the same input.
 */
import { describe, it, expect } from 'vitest'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { FALLBACK_SEED_TOOLS, createRandom, sampleInvalidInput } from '@mcp-gateway/db'

type Check = (input: unknown) => { valid: true; data: unknown } | { valid: false; errorMessage: string }

const str = { type: 'string' }
// The stored schemas of the Petstore demo project's two user tools (no `required`, as in the real spec).
const loginUser = { type: 'object', properties: { password: str, username: str } }
const createUser = {
  type: 'object',
  properties: { id: { type: 'integer' }, email: str, phone: str, lastName: str, password: str, username: str, firstName: str, userStatus: { type: 'integer' } },
}
const withHidden = { type: 'object', properties: { petId: { type: 'integer' }, region: str }, required: ['petId', 'region'] }

const tools = [
  ...FALLBACK_SEED_TOOLS.map((t) => ({ name: t.name, inputSchema: t.inputSchema, hidden: undefined as unknown })),
  { name: 'loginUser', inputSchema: loginUser, hidden: undefined },
  { name: 'createUser', inputSchema: createUser, hidden: undefined },
  { name: 'getPet', inputSchema: withHidden, hidden: { region: 'eu' } },
]

describe('seeded VALIDATION messages', () => {
  it.each(tools)('$name: the seed message equals the gateway validator message for the same input', ({ name, inputSchema, hidden }) => {
    // The gateway validates against the agent's schema: the input schema without the hidden parameters.
    const agentSchema = structuredClone(inputSchema) as { type: 'object'; properties: Record<string, unknown>; required?: string[] }
    for (const h of Object.keys((hidden as object | undefined) ?? {})) {
      delete agentSchema.properties[h]
      agentSchema.required = agentSchema.required?.filter((r) => r !== h)
    }
    // Built exactly as ValidatorCache does in call-tool.ts.
    const check = new AjvJsonSchemaValidator().getValidator(agentSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]) as unknown as Check

    let seen = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = createRandom(seed)
      for (let i = 0; i < 20; i++) {
        const sample = sampleInvalidInput(name, inputSchema, hidden, random)
        if (!sample) continue
        seen++
        const result = check(sample.input)
        expect(result.valid).toBe(false)
        if (!result.valid) expect(sample.errorMessage).toBe(`Invalid arguments for "${name}": ${result.errorMessage}`)
      }
    }
    expect(seen).toBeGreaterThan(0)
  })
})
