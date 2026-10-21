/**
 * The Connect page: only the owner can open it, and nothing about an API key reaches it. Real database; the
 * session and environment are stubbed.
 */
import { generateApiKey } from '@mcp-gateway/crypto'
import { db } from '@mcp-gateway/db'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ userId: '' }))
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock('@/auth', () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }))
vi.mock('@/lib/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/env')>()), env: () => settings.value }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
  usePathname: () => '/projects/x/connect',
}))

import ConnectPage from '@/app/(dashboard)/projects/[slug]/connect/page'
import { ConnectionSnippet } from '@/components/connection-snippet'
import { ProjectNav } from '@/components/project-nav'

const users: string[] = []
let slug: string
let otherSlug: string
let realKey: ReturnType<typeof generateApiKey>

beforeAll(async () => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const owner = await db.user.create({ data: { email: `connect-owner-${tag}@test.local`, name: 'Owner' } })
  const other = await db.user.create({ data: { email: `connect-other-${tag}@test.local`, name: 'Other' } })
  users.push(owner.id, other.id)
  session.userId = owner.id

  slug = `connect-${tag}`
  const mine = await db.project.create({ data: { userId: owner.id, name: 'Mine', slug, upstreamBaseUrl: 'https://api.example.com' } })
  realKey = generateApiKey()
  await db.apiKey.create({ data: { projectId: mine.id, name: 'real key', prefix: realKey.prefix, hash: realKey.hash } })

  otherSlug = `connect-other-${tag}`
  await db.project.create({ data: { userId: other.id, name: 'Theirs', slug: otherSlug, upstreamBaseUrl: '' } })
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users } } })
})

// Everything the page element holds, including props handed to client components. React elements can be cyclic.
function serialise(node: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(node, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return undefined
      seen.add(value)
    }
    return value
  })
}

const render = (s: string) => ConnectPage({ params: Promise.resolve({ slug: s }) })

describe('the Connect page', () => {
  it("is a not-found for another user's project and for one that does not exist", async () => {
    settings.value = { GATEWAY_PUBLIC_URL: 'https://gw.example.com' }
    await expect(render(otherSlug)).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(render('no-such-project')).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is a not-found when nobody is signed in', async () => {
    const was = session.userId
    session.userId = ''
    try {
      await expect(render(slug)).rejects.toThrow('NEXT_NOT_FOUND')
    } finally {
      session.userId = was
    }
  })

  it('shows the real URL, the slug and the per-project variable in the snippets', async () => {
    settings.value = { GATEWAY_PUBLIC_URL: 'https://gw.example.com/' }
    const payload = serialise(await render(slug))
    expect(payload).toContain(`https://gw.example.com/mcp/${slug}`)
    expect(payload).toContain(`claude mcp add --transport http ${slug} `)
    expect(payload).toContain(`${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_KEY`)
    expect(payload).toContain('Read-Host')
    expect(payload).toContain('AsSecureString')
    expect(payload).toContain('read -rs')
    expect(payload).not.toContain('<YOUR_API_KEY>')
    expect(payload).toContain(`/projects/${slug}/api-keys`) // the way to get a key
  })

  it("never holds an API key: not the project's real key, its hash, or its prefix", async () => {
    settings.value = { GATEWAY_PUBLIC_URL: 'https://gw.example.com' }
    const payload = serialise(await render(slug))
    expect(payload).not.toContain(realKey.key)
    expect(payload).not.toContain(realKey.hash)
    expect(payload).not.toContain(realKey.prefix)
    expect(payload).not.toMatch(/mcpg_/)
  })

  it('has a troubleshooting card for "fetch failed", with a length check for the right variable', async () => {
    settings.value = { GATEWAY_PUBLIC_URL: 'https://gw.example.com' }
    const payload = serialise(await render(slug))
    const name = `${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_KEY`
    expect(payload).toContain('Troubleshooting')
    expect(payload).toContain('fetch failed')
    expect(payload).toContain('Check its length first')
    expect(payload).toContain(`$env:${name}.Length`)
    expect(payload).toContain('37 characters')
  })

  it('warns that a localhost address only works on this machine, and says nothing of the kind for a public one', async () => {
    settings.value = { GATEWAY_PUBLIC_URL: 'http://localhost:4000' }
    expect(serialise(await render(slug))).toContain('only works on this machine')
    settings.value = { GATEWAY_PUBLIC_URL: 'https://gw.example.com' }
    expect(serialise(await render(slug))).not.toContain('only works on this machine')
  })

  it('points Claude Desktop and claude.ai users to OAuth/request-header support and Claude Code, with no mcp-remote', async () => {
    settings.value = { GATEWAY_PUBLIC_URL: 'https://gw.example.com' }
    const payload = serialise(await render(slug))
    expect(payload).toContain('Claude Desktop and claude.ai')
    expect(payload).toContain('https://claude.com/docs/connectors/building/authentication')
    expect(payload).not.toMatch(/mcp-remote/i)
  })
})

describe('the way to the page', () => {
  it('the project tabs include Connect, linking to the project connect page', () => {
    const html = renderToStaticMarkup(createElement(ProjectNav, { slug: 'x' }))
    expect(html).toContain('href="/projects/x/connect"')
    expect(html).toContain('>Connect<')
  })

  it('the Overview card shows the URL and links to the Connect tab, without the old Inspector steps', () => {
    const html = renderToStaticMarkup(createElement(ConnectionSnippet, { url: 'https://gw.example.com/mcp/x', slug: 'x' }))
    expect(html).toContain('https://gw.example.com/mcp/x')
    expect(html).toContain('href="/projects/x/connect"')
    expect(html).not.toMatch(/Add Servers|Custom Headers|mcp-inspector\/mcp\.json/)
  })
})
