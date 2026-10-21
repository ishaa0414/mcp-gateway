import { buildFields, toArguments, toFieldText, type PlaygroundField } from '@/lib/playground/fields'
import { checkParamValue } from '@/lib/tool-editor/value-check'

/**
 * The editor's "Parameters" draft: for each input parameter, whether it is hidden from agents and the
 * fixed value as the text in its form control. Pure, so the rules are tested without a browser.
 */

export interface ParamDraft {
  hidden: boolean
  text: string
}
export type HiddenDraft = Record<string, ParamDraft>
export type StoredHidden = Record<string, { value: unknown; required?: boolean }>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const REQUIRED_NEEDS_VALUE = 'A required parameter can only be hidden with a fixed value.'

/** The parameters of a tool, as form fields (required ones first). */
export function paramFields(inputSchema: unknown): PlaygroundField[] {
  return buildFields(inputSchema)
}

/** The draft for a tool: its stored hidden parameters switched on, with their values as text. */
export function initialDraft(inputSchema: unknown, stored: unknown): HiddenDraft {
  const hidden = isRecord(stored) ? stored : {}
  const draft: HiddenDraft = {}
  for (const field of paramFields(inputSchema)) {
    const entry = hidden[field.name]
    draft[field.name] = field.name in hidden ? { hidden: true, text: toFieldText(field, isRecord(entry) ? entry['value'] : undefined) } : { hidden: false, text: '' }
  }
  return draft
}

export type DraftResult = { ok: true; hiddenParams: StoredHidden } | { ok: false; errors: Record<string, string> }

/**
 * The `hiddenParams` to save from a draft. An empty value on an optional parameter is allowed and
 * stored as null: the parameter is then never sent. A required parameter needs a value.
 */
export function draftToHiddenParams(inputSchema: unknown, draft: HiddenDraft): DraftResult {
  const properties = isRecord(inputSchema) && isRecord(inputSchema['properties']) ? inputSchema['properties'] : {}
  const hiddenParams: StoredHidden = {}
  const errors: Record<string, string> = {}

  for (const field of paramFields(inputSchema)) {
    const row = draft[field.name]
    if (!row?.hidden) continue

    if (row.text.trim() === '') {
      if (field.required) errors[field.name] = REQUIRED_NEEDS_VALUE
      else hiddenParams[field.name] = { value: null, required: false }
      continue
    }

    const converted = toArguments([field], { [field.name]: row.text })
    if (!converted.ok) {
      errors[field.name] = converted.errors[field.name]!
      continue
    }
    const value = converted.arguments[field.name]
    const problem = checkParamValue(properties[field.name], value)
    if (problem) errors[field.name] = problem
    else hiddenParams[field.name] = { value, required: field.required }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, hiddenParams }
}
