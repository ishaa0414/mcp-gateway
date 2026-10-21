/**
 * The loading, error and not-found states. Rendered to HTML (the suite has no browser): an error page must never
 * show the error's message, Try again must call `retry`, and every special file the app relies on must exist.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorPanel } from '@/components/error-panel'

// A message like one a real failure could carry: connection details and a password.
const SECRET = 'connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/mcpgateway'
const failure = (digest?: string) => Object.assign(new Error(SECRET), digest === undefined ? {} : { digest })
const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement)

/** The first element in a tree that matches. Function components that use no hooks can be called to expand them. */
function find(node: ReactNode, test: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, test)
      if (hit) return hit
    }
    return null
  }
  if (!isValidElement(node)) return null
  const el = node as ReactElement<Record<string, unknown>>
  if (test(el)) return el
  // A function component (none of these use hooks) is expanded by calling it, the way React would.
  if (typeof el.type === 'function') return find((el.type as (props: unknown) => ReactNode)(el.props), test)
  return find(el.props['children'] as ReactNode, test)
}

describe('the error page', () => {
  it('shows a generic message and the digest, and nothing from the error', () => {
    const out = html(createElement(ErrorPanel, { error: failure('1234567890'), retry: () => undefined }))
    expect(out).toContain('Something went wrong.')
    expect(out).toContain('Try again — if it keeps happening, share this reference: ')
    expect(out).toContain('<code class="rounded bg-muted px-1.5 py-0.5 text-xs">1234567890</code>.')
    for (const leaked of [SECRET, 'hunter2', 'ECONNREFUSED', 'db.internal', 'postgres://', 'Error:']) expect(out).not.toContain(leaked)
  })

  it('does not hand the error object to anything it renders, so the message cannot reach the browser through props', () => {
    const tree = ErrorPanel({ error: failure('abc'), retry: () => undefined })
    const seen = new WeakSet<object>()
    const serialised = JSON.stringify(tree, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return undefined
        seen.add(v)
      }
      return v
    })
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain(SECRET)
  })

  it('without a digest (an error thrown in the browser has none) says only "Try again.", with no empty reference', () => {
    const out = html(createElement(ErrorPanel, { error: failure(), retry: () => undefined }))
    expect(out).toContain('Try again.')
    expect(out).not.toContain('share this reference')
    expect(out).not.toMatch(/undefined|null|<code/)
    expect(out).not.toContain(SECRET)
  })

  it('shows the digest as text, never as markup', () => {
    const out = html(createElement(ErrorPanel, { error: failure('<script>alert(1)</script>'), retry: () => undefined }))
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })

  it('Try again calls retry, once per click, and nothing else', () => {
    const retry = vi.fn()
    const tree = ErrorPanel({ error: failure('d1'), retry })
    const button = find(tree, (el) => el.type === 'button')
    expect(button).not.toBeNull()
    expect(retry).not.toHaveBeenCalled()
    ;(button!.props['onClick'] as () => void)()
    ;(button!.props['onClick'] as () => void)()
    expect(retry).toHaveBeenCalledTimes(2)
    expect(retry.mock.calls.every((call) => call.length === 0)).toBe(true)
  })

  it('has a way out: a plain link back to the projects', () => {
    const tree = ErrorPanel({ error: failure('d1'), retry: () => undefined })
    const link = find(tree, (el) => el.type === 'a')
    expect(link?.props['href']).toBe('/projects')
  })

  it('is announced to assistive technology', () => {
    expect(html(createElement(ErrorPanel, { error: failure('d'), retry: () => undefined }))).toContain('role="alert"')
  })
})

const ERROR_FILES = [
  ['the root error page', '@/app/error'],
  ['the dashboard error page', '@/app/(dashboard)/error'],
  ['the project error page', '@/app/(dashboard)/projects/[slug]/error'],
  ['the global error page', '@/app/global-error'],
] as const

describe.each(ERROR_FILES)('%s', (_name, path) => {
  it('renders the generic message and digest and never the message, with a working retry', async () => {
    const Page = (await import(/* @vite-ignore */ path)).default as (props: { error: Error & { digest?: string }; retry: () => void }) => ReactElement
    const retry = vi.fn()
    const tree = Page({ error: failure('ref-9'), retry })
    const out = html(tree)
    expect(out).toContain('Something went wrong.')
    expect(out).toContain('ref-9')
    for (const leaked of [SECRET, 'hunter2', 'ECONNREFUSED']) expect(out).not.toContain(leaked)
    ;(find(tree, (el) => el.type === 'button')!.props['onClick'] as () => void)()
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('the global error page', () => {
  it('brings its own document, because it replaces the root layout', async () => {
    const GlobalError = (await import('@/app/global-error')).default
    const out = html(GlobalError({ error: failure('g1'), retry: () => undefined }))
    expect(out.startsWith('<html lang="en">')).toBe(true)
    expect(out).toContain('<body')
    expect(out).toContain('</html>')
  })
})

describe('not found', () => {
  const NOT_FOUND = [
    ['the dashboard', '@/app/(dashboard)/not-found'],
    ['the root', '@/app/not-found'],
  ] as const

  it.each(NOT_FOUND)('%s page links back to the projects', async (_name, path) => {
    const Page = (await import(/* @vite-ignore */ path)).default as () => ReactElement
    const out = html(Page())
    expect(out).toContain('href="/projects"')
    expect(out).toContain('Back to projects')
  })

  it('the dashboard page gives the same answer for a project that is missing and one that is not yours', async () => {
    const Page = (await import('@/app/(dashboard)/not-found')).default
    const out = html(Page())
    expect(out).toContain('It may not exist, or you may not have access to it.')
    // It takes no input at all, so it cannot say which of the two it was.
    expect(Page.length).toBe(0)
  })
})

const LOADING_FILES = [
  ['the dashboard', '@/app/(dashboard)/loading', 'Loading'],
  ['a project tab', '@/app/(dashboard)/projects/[slug]/loading', 'Loading'],
  ['Tools', '@/app/(dashboard)/projects/[slug]/tools/loading', 'Loading tools'],
  ['API Keys', '@/app/(dashboard)/projects/[slug]/api-keys/loading', 'Loading API keys'],
  ['Spec', '@/app/(dashboard)/projects/[slug]/spec/loading', 'Loading'],
] as const

describe.each(LOADING_FILES)('the %s loading state', (_name, path, label) => {
  it('is a busy status with a spoken label, built from hidden blocks', async () => {
    const Loading = (await import(/* @vite-ignore */ path)).default as () => ReactElement
    const out = html(Loading())
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-busy="true"')
    expect(out).toContain(`<span class="sr-only">${label}</span>`)
    expect(out).toContain('animate-pulse')
    expect(out).toContain('aria-hidden="true"')
  })

  it('shows no data of its own', async () => {
    const Loading = (await import(/* @vite-ignore */ path)).default as () => ReactElement
    expect(html(Loading())).not.toMatch(/api_key|mcpg_|@|http/)
  })
})

describe('the special files the app relies on', () => {
  it.each([
    '@/app/error',
    '@/app/global-error',
    '@/app/not-found',
    '@/app/(dashboard)/error',
    '@/app/(dashboard)/not-found',
    '@/app/(dashboard)/loading',
    '@/app/(dashboard)/projects/[slug]/error',
    '@/app/(dashboard)/projects/[slug]/loading',
    '@/app/(dashboard)/projects/[slug]/tools/loading',
    '@/app/(dashboard)/projects/[slug]/api-keys/loading',
    '@/app/(dashboard)/projects/[slug]/spec/loading',
  ])('%s exists and has a default export', async (path) => {
    const mod = await import(/* @vite-ignore */ path)
    expect(typeof mod.default).toBe('function')
  })
})
