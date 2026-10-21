/**
 * The dashboard at phone width. The suite has no browser, so these check the contract the layout depends on in
 * rendered markup and in the source: which element shows at which breakpoint, the menu button's accessibility
 * attributes, scrolling tabs, cards instead of a wide table. What a drawer does once open (Esc, focus trap,
 * focus return) is Radix Dialog's behaviour and is checked in the browser, not here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const path = vi.hoisted(() => ({ value: '/projects/shop/tools' }))
vi.mock('next/navigation', () => ({ usePathname: () => path.value, useRouter: () => ({ refresh: () => undefined }) }))
vi.mock('@/auth', () => ({ signOut: async () => undefined }))

import { ApiKeysPanel } from '@/components/api-keys-panel'
import { MobileNav } from '@/components/mobile-nav'
import { ProjectNav } from '@/components/project-nav'
import { Sidebar, SidebarContent } from '@/components/sidebar'
import { ToolParameters } from '@/components/tool-parameters'
import { buildFields } from '@/lib/playground/fields'

const SRC = join(__dirname, '..')
const source = (file: string) => readFileSync(join(SRC, file), 'utf8')
const user = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', image: null }
const classOf = (html: string, startsWith: string) => new RegExp(`<${startsWith}[^>]*class="([^"]*)"`).exec(html)?.[1] ?? ''
const tokens = (cls: string) => cls.split(/\s+/)

describe('the shell switches at md (768 px)', () => {
  it('the desktop sidebar is hidden below md and flex from md; the phone top bar is hidden from md', () => {
    const desktop = renderToStaticMarkup(createElement(Sidebar, { user }))
    const phone = renderToStaticMarkup(createElement(MobileNav, null, createElement('p', null, 'drawer body')))
    expect(tokens(classOf(desktop, 'aside'))).toEqual(expect.arrayContaining(['hidden', 'md:flex', 'w-64']))
    expect(tokens(classOf(phone, 'header'))).toContain('md:hidden')
    expect(tokens(classOf(phone, 'header'))).not.toContain('hidden')
  })

  it('the layout stacks the bar above the page below md and puts them side by side from md, on the dynamic viewport height', () => {
    const layout = source('app/(dashboard)/layout.tsx')
    expect(layout).toContain('flex h-dvh flex-col overflow-hidden')
    expect(layout).toContain('md:flex-row')
    expect(layout).not.toContain('h-screen')
    expect(source('components/sidebar.tsx')).not.toContain('h-screen')
  })

  it('a fixed sidebar width exists only on an element that is hidden below md', () => {
    const sidebar = source('components/sidebar.tsx')
    const widthLines = sidebar.split('\n').filter((line) => /\bw-64\b/.test(line))
    expect(widthLines).toHaveLength(1)
    expect(widthLines[0]).toMatch(/hidden .*w-64 .*md:flex/)
  })
})

describe('the menu button', () => {
  const html = renderToStaticMarkup(createElement(MobileNav, null, createElement('p', null, 'drawer body')))

  it('is labelled, announces that it opens a dialog, and says it is closed', () => {
    expect(html).toMatch(/<button[^>]*aria-label="Open menu"/)
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"/)
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/)
    // Radix adds aria-controls only while the drawer is open: until then it would point at an element that is not in the page.
    expect(html).not.toContain('aria-controls')
  })

  it('shows the brand beside it, linking to the projects', () => {
    expect(html).toContain('MCP Gateway')
    expect(html).toContain('href="/projects"')
  })

  it('keeps the drawer out of the page until it is opened (nothing to tab into, nothing read aloud)', () => {
    expect(html).not.toContain('drawer body')
    expect(html).not.toContain('Close menu')
  })

  it('shows a keyboard focus ring on the button and the brand link', () => {
    expect(html.match(/focus-visible:ring-2/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the drawer content (the sidebar body)', () => {
  const html = renderToStaticMarkup(createElement(SidebarContent, { user }))

  it('has the navigation, the signed-in user and Sign out, all present', () => {
    expect(html).toContain('aria-label="Main"')
    expect(html).toContain('href="/projects"')
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('ada@example.com')
    expect(html).toMatch(/<button[^>]*aria-label="Sign out"/)
  })

  it('pins the user block to the bottom while the links scroll above it, so Sign out is always reachable', () => {
    expect(classOf(html, 'nav')).toContain('overflow-y-auto')
    expect(classOf(html, 'nav')).toContain('min-h-0')
    expect(html).toMatch(/class="mt-auto shrink-0 border-t/)
  })

  it('shows a keyboard focus ring on the links and on Sign out', () => {
    expect(html.match(/focus-visible:ring-2/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the project tabs', () => {
  const html = renderToStaticMarkup(createElement(ProjectNav, { slug: 'shop' }))

  it('scroll sideways instead of widening the page, and no tab wraps or shrinks', () => {
    expect(html).toMatch(/^<div[^>]*class="[^"]*overflow-x-auto/)
    expect(classOf(html, 'nav')).toEqual(expect.stringContaining('w-max'))
    const links = html.match(/<a [^>]*>/g) ?? []
    expect(links).toHaveLength(8)
    for (const link of links) expect(link).toMatch(/shrink-0 whitespace-nowrap/)
  })

  it('marks the current tab, so it can be scrolled into view and announced', () => {
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Tools<\/a>/)
  })

  it('shows a keyboard focus ring on every tab', () => {
    for (const link of html.match(/<a [^>]*>/g) ?? []) expect(link).toContain('focus-visible:ring-2')
  })
})

describe('API keys', () => {
  const keys = [
    { id: 'k1', name: 'Claude Desktop (Alice)', prefix: 'mcpg_aB3x…', rateLimitPerMin: 60, createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null, revokedAt: null },
    { id: 'k2', name: 'Old key', prefix: 'mcpg_zZ9y…', rateLimitPerMin: 30, createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: '2026-09-02T10:00:00.000Z', revokedAt: '2026-09-03T10:00:00.000Z' },
  ]
  const html = renderToStaticMarkup(createElement(ApiKeysPanel, { slug: 'shop', keys }))

  it('shows a table from md and one card per key below md, never both at once', () => {
    expect(html).toMatch(/<table[^>]*class="hidden[^"]*md:table"/)
    expect(html).toMatch(/<ul[^>]*class="[^"]*md:hidden"/)
  })

  it('every key is in both, with its action: Revoke for an active key, a badge for a revoked one', () => {
    for (const k of keys) expect(html.split(k.name).length - 1).toBeGreaterThanOrEqual(2)
    expect(html.match(/Revoke<span class="sr-only"> Claude Desktop \(Alice\)<\/span>/g)).toHaveLength(2)
    expect(html.match(/Revoked/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('the card shows the key prefix and dates, and lets a long prefix wrap', () => {
    expect(html).toContain('<dd class="break-all font-mono">mcpg_aB3x…</dd>')
    expect(html).toContain('Last used')
  })

  it('the heading row stacks the button under the text on a phone', () => {
    expect(html).toContain('flex flex-col gap-3 sm:flex-row')
  })
})

describe('other pages', () => {
  it('the Overview stat cards stack below sm', () => {
    expect(source('app/(dashboard)/projects/[slug]/overview/page.tsx')).toContain('grid grid-cols-1 gap-4 sm:grid-cols-3')
  })

  it('the Parameters rows put the hide switch under the name on a phone', () => {
    const fields = buildFields({ type: 'object', properties: { region: { type: 'string' } } })
    const html = renderToStaticMarkup(createElement(ToolParameters, { fields, draft: { region: { hidden: false, text: '' } }, errors: {}, projectSlug: 'shop', onChange: () => undefined }))
    expect(html).toContain('flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between')
  })

  it('dialogs are never wider than the screen minus a margin, and scroll when taller than it', () => {
    const dialog = source('components/ui/dialog.tsx')
    expect(dialog).toContain('w-[calc(100vw-2rem)]')
    expect(dialog).toContain('sm:w-full')
    expect(dialog).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog).toContain('overflow-y-auto')
  })

  it('the tool editor tab list scrolls instead of overflowing', () => {
    expect(source('components/tool-list.tsx')).toContain('<TabsList className="max-w-full justify-start overflow-x-auto">')
  })
})

describe('guards against the patterns that broke at 375 px', () => {
  const PAGE_FILES = [
    'app/(dashboard)/layout.tsx',
    'app/(dashboard)/loading.tsx',
    'app/(dashboard)/projects/page.tsx',
    'app/(dashboard)/projects/new/page.tsx',
    'app/(dashboard)/projects/[slug]/layout.tsx',
    'app/(dashboard)/projects/[slug]/overview/page.tsx',
    'components/error-panel.tsx',
    'components/not-found-panel.tsx',
  ]

  it('page-level padding is smaller on a phone: p-8 and px-8 only ever with an md: prefix', () => {
    for (const file of PAGE_FILES) {
      const text = source(file)
      expect(text.match(/(?<![:\w-])p[xy]?-8\b/g) ?? [], `${file} has a bare p-8/px-8`).toEqual([])
    }
  })

  it('no grid has three or more fixed columns without a breakpoint prefix', () => {
    for (const file of PAGE_FILES) {
      expect(source(file).match(/(?<![:\w-])grid-cols-[3-9]\b/g) ?? [], `${file} has a bare grid-cols-3+`).toEqual([])
    }
  })
})
