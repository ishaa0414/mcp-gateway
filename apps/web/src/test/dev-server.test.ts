import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const scripts = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

describe('the web app scripts', () => {
  it('the dev server listens on the loopback address only, so it is not reachable from the network', () => {
    expect(scripts['dev']).toBe('next dev --hostname 127.0.0.1 --port 3000')
    expect(scripts['dev']).not.toContain('0.0.0.0')
  })

  it('the production server is left to the host: it keeps its port and gets no hostname from us', () => {
    expect(scripts['start']).toBe('next start --port 3000')
  })
})
