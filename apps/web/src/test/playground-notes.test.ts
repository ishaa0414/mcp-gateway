import { describe, expect, it } from 'vitest'
import { confirmMessage, requestNote } from '@/lib/playground/notes'

describe('what the Playground says is hidden', () => {
  it('names only what applies to this project and tool', () => {
    expect(requestNote({ hasCredential: true, hasHidden: true })).toBe('Your stored credential and hidden parameters are hidden here; the real request carries them.')
    expect(requestNote({ hasCredential: true, hasHidden: false })).toBe('Your stored credential is hidden here; the real request carries it.')
    expect(requestNote({ hasCredential: false, hasHidden: true })).toBe('Hidden parameters are shown as HIDDEN here; the real request carries their values.')
  })

  it('says nothing when neither applies', () => {
    expect(requestNote({ hasCredential: false, hasHidden: false })).toBeNull()
  })

  it('does not mention a credential or hidden parameters that are not there', () => {
    for (const facts of [{ hasCredential: false, hasHidden: true }, { hasCredential: false, hasHidden: false }]) {
      expect(requestNote(facts) ?? '').not.toMatch(/credential/i)
    }
    expect(requestNote({ hasCredential: true, hasHidden: false })).not.toMatch(/hidden parameters/i)
  })

  it('the confirm message mentions the stored credential only when there is one', () => {
    expect(confirmMessage('POST', '/pets', { hasCredential: true, hasHidden: false })).toBe(
      'This will send a real POST to /pets with your stored credential. It can change or delete data in your API.'
    )
    expect(confirmMessage('DELETE', '/pets/{petId}', { hasCredential: false, hasHidden: true })).toBe(
      'This will send a real DELETE to /pets/{petId}. It can change or delete data in your API.'
    )
  })
})
