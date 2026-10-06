import { z } from 'zod'

// Headers the HTTP client controls itself; letting a user "set" them would be ignored at best.
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
])

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ // RFC 9110 "token"
const QUERY_NAME = /^[A-Za-z0-9_.~-]+$/

const headerName = z
  .string()
  .trim()
  .min(1, 'Enter the header name')
  .max(100)
  .regex(HEADER_NAME, 'Header names can only contain letters, digits and !#$%&\'*+-.^_`|~')
  .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), 'That header is set by the gateway itself; choose another name')

const queryParamName = z
  .string()
  .trim()
  .min(1, 'Enter the query parameter name')
  .max(100)
  .regex(QUERY_NAME, 'Use letters, digits, and _ . ~ - only')

// A line break in a header value would let the value inject further headers.
const secretValue = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .trim()
    .min(1, 'Enter the credential value')
    .max(2000, 'That value is too long')
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v), 'The value must not contain line breaks or control characters')
    .optional()
)

/**
 * What the Settings form may send. `value` is optional because leaving it empty means "keep
 * the stored secret"; the action decides when a value is actually required.
 */
export const CredentialInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NONE') }),
  z.object({ type: z.literal('BEARER'), value: secretValue }),
  z.object({ type: z.literal('CUSTOM_HEADER'), headerName, value: secretValue }),
  z.object({ type: z.literal('QUERY_PARAM'), queryParamName, value: secretValue }),
])

export type CredentialInput = z.infer<typeof CredentialInputSchema>
