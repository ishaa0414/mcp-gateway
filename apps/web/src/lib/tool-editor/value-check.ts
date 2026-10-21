/**
 * Does a value fit a parameter's schema? A small check for the fixed value of a hidden parameter, used
 * by the editor (to say so before saving) and by `updateTool` (which does not trust the editor). It
 * covers what a parameter schema usually says: enum, type, integer, minimum and maximum, and the items
 * of an array. The gateway's own check of agent arguments is separate and stays the authority for those.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A message when `value` does not fit `schema`, else null. `value` is not null or undefined. */
export function checkParamValue(schema: unknown, value: unknown): string | null {
  if (!isRecord(schema)) return null

  const choices = schema['enum']
  if (Array.isArray(choices) && choices.length > 0 && !choices.some((c) => JSON.stringify(c) === JSON.stringify(value))) {
    return `Must be one of: ${choices.map((c) => JSON.stringify(c)).join(', ')}.`
  }

  switch (schema['type']) {
    case 'string':
      return typeof value === 'string' ? null : 'Must be text.'
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number.'
      if (schema['type'] === 'integer' && !Number.isInteger(value)) return 'Must be a whole number.'
      if (typeof schema['minimum'] === 'number' && value < schema['minimum']) return `Must be at least ${schema['minimum']}.`
      if (typeof schema['maximum'] === 'number' && value > schema['maximum']) return `Must be at most ${schema['maximum']}.`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Must be true or false.'
    case 'array': {
      if (!Array.isArray(value)) return 'Must be a list.'
      for (const [index, item] of value.entries()) {
        if (item === null || item === undefined) return `Item ${index + 1} is empty.`
        const problem = checkParamValue(schema['items'], item)
        if (problem) return `Item ${index + 1}: ${problem}`
      }
      return null
    }
    case 'object':
      return isRecord(value) ? null : 'Must be a JSON object.'
    default:
      return null
  }
}
