/**
 * Sentences about what the Playground hides or uses, saying only what applies to this project and tool.
 * `hasCredential`: the project has an upstream credential. `hasHidden`: this tool has a hidden
 * parameter whose value is sent (one fixed to "never send" has nothing to hide).
 */
export interface PrivacyFacts {
  hasCredential: boolean
  hasHidden: boolean
}

/** Under the request in the result panel, or null when nothing is hidden there. */
export function requestNote({ hasCredential, hasHidden }: PrivacyFacts): string | null {
  if (hasCredential && hasHidden) return 'Your stored credential and hidden parameters are hidden here; the real request carries them.'
  if (hasCredential) return 'Your stored credential is hidden here; the real request carries it.'
  if (hasHidden) return 'Hidden parameters are shown as HIDDEN here; the real request carries their values.'
  return null
}

/** The body of the confirm dialog for a tool that changes data. */
export function confirmMessage(method: string, path: string, { hasCredential }: PrivacyFacts): string {
  return `This will send a real ${method} to ${path}${hasCredential ? ' with your stored credential' : ''}. It can change or delete data in your API.`
}
