import { describe, expect, it } from 'vitest'
import { apiKeyEnvName } from '@/lib/connect/env-name'
import { generateApiKey } from '@mcp-gateway/crypto'
import {
  buildGuides,
  envBlocks,
  FETCH_FAILED_HELP,
  INSPECTOR_V1_VERSION,
  INSPECTOR_VERSION,
  KEY_LENGTH,
  lengthCheckBlocks,
  type ClientGuide,
} from '@/lib/connect/snippets'

describe('apiKeyEnvName', () => {
  it('upper-cases, turns every other character into "_", and ends in _MCP_KEY', () => {
    expect(apiKeyEnvName('petstore-demo')).toBe('PETSTORE_DEMO_MCP_KEY')
    expect(apiKeyEnvName('shop')).toBe('SHOP_MCP_KEY')
    expect(apiKeyEnvName('a-b-c')).toBe('A_B_C_MCP_KEY')
  })

  it('does not collapse repeated hyphens, so different slugs keep different names', () => {
    expect(apiKeyEnvName('a--b')).toBe('A__B_MCP_KEY')
    expect(apiKeyEnvName('a-b')).not.toBe(apiKeyEnvName('a--b'))
  })

  it('puts P_ in front of a name that would start with a digit', () => {
    expect(apiKeyEnvName('3d-shop')).toBe('P_3D_SHOP_MCP_KEY')
    expect(apiKeyEnvName('123')).toBe('P_123_MCP_KEY')
    expect(apiKeyEnvName('shop3')).toBe('SHOP3_MCP_KEY') // a digit later in the name is fine
  })

  it('leaves an already-underscored name as it is (underscore is not a letter or digit, and maps to itself)', () => {
    expect(apiKeyEnvName('my_app')).toBe('MY_APP_MCP_KEY')
    expect(apiKeyEnvName('_x_')).toBe('_X__MCP_KEY')
  })

  it('always gives a valid environment variable name for any slug the app accepts', () => {
    for (const slug of ['abc', '-abc', 'abc-', '0-0', '9zz', 'a'.repeat(48), '---']) {
      expect(apiKeyEnvName(slug)).toMatch(/^[A-Z_][A-Z0-9_]*$/)
    }
  })
})

const URL_ = 'http://localhost:4000/mcp/petstore-demo'
const SLUG = 'petstore-demo'
const VAR = 'PETSTORE_DEMO_MCP_KEY'
const guides = buildGuides({ url: URL_, slug: SLUG })
const guide = (id: ClientGuide['id']) => guides.find((g) => g.id === id)!
const block = (id: ClientGuide['id'], labelPart: string) => guide(id).blocks.find((b) => b.label.includes(labelPart))!.text
const everything = JSON.stringify([guides, envBlocks(SLUG)])

describe('the guides', () => {
  it('cover the four clients, each with an official documentation link', () => {
    expect(guides.map((g) => g.id)).toEqual(['inspector', 'claude-code', 'cursor', 'vscode'])
    expect(guides.map((g) => new URL(g.docUrl).hostname)).toEqual(['github.com', 'code.claude.com', 'cursor.com', 'code.visualstudio.com'])
  })

  it('use the real URL and the slug, and a key only as a variable or a prompt', () => {
    for (const g of guides) {
      const text = g.blocks.map((b) => b.text).join('\n')
      expect(text).toContain(URL_)
    }
    expect(everything).not.toMatch(/mcpg_/) // no API key value of any shape
    expect(everything).not.toContain('<YOUR_API_KEY>') // there is no placeholder to replace and leave in history
  })

  describe('setting the key variable', () => {
    const [bash, powershell] = envBlocks(SLUG).map((b) => b.text) as [string, string]

    it('asks for the key without showing it (read -s for bash, Read-Host -AsSecureString for PowerShell)', () => {
      expect(bash).toBe(`printf 'API key: '; read -rs ${VAR}; echo; export ${VAR}`)
      expect(powershell).toBe(`$env:${VAR} = [System.Net.NetworkCredential]::new('', (Read-Host 'API key' -AsSecureString)).Password`)
    })

    it('never puts a key, or a quoted value to type one in, on the line that would reach shell history', () => {
      expect(bash).not.toMatch(/export \w+=/) // not `export NAME="value"`
      expect(powershell).not.toMatch(/\$env:\w+\s*=\s*["']/) // not `$env:NAME = "value"`
      for (const text of [bash, powershell]) expect(text).not.toMatch(/mcpg_|<YOUR/)
    })

    it('uses the per-project variable, in both shells', () => {
      expect(bash).toContain(VAR)
      expect(powershell).toContain(VAR)
      const other = envBlocks('3d-shop').map((b) => b.text).join(' | ')
      expect(other).toContain('P_3D_SHOP_MCP_KEY')
      expect(other).not.toContain(VAR)
    })
  })

  describe('troubleshooting "fetch failed"', () => {
    it('says what it usually means and to check the length first, with the real key length', () => {
      expect(FETCH_FAILED_HELP).toContain('"fetch failed" with no other detail usually means the key variable is wrong')
      expect(FETCH_FAILED_HELP).toContain('control character')
      expect(FETCH_FAILED_HELP).toContain('Check its length first')
      expect(FETCH_FAILED_HELP).toContain(`${KEY_LENGTH} characters`)
    })

    it('the length really is what the app generates', () => {
      for (let i = 0; i < 20; i++) expect(generateApiKey().key).toHaveLength(KEY_LENGTH)
    })

    it('gives a length check for each shell that prints the length, not the key', () => {
      const [bash, powershell] = lengthCheckBlocks(SLUG).map((b) => b.text)
      expect(bash).toBe(`echo \${#${VAR}}`)
      expect(powershell).toBe(`$env:${VAR}.Length`)
    })
  })

  it('every JSON block is valid JSON', () => {
    for (const g of guides) for (const b of g.blocks.filter((x) => x.language === 'json')) expect(() => JSON.parse(b.text)).not.toThrow()
  })

  describe('MCP Inspector', () => {
    it('main form: pinned current version, --cli first, --server-url, http transport, header from the variable, tools/list', () => {
      expect(block('inspector', 'bash')).toBe(
        `npx @modelcontextprotocol/inspector@${INSPECTOR_VERSION} --cli --server-url ${URL_} --transport http --header "Authorization: Bearer $${VAR}" --method tools/list`
      )
      expect(block('inspector', 'PowerShell')).toBe(
        `npx @modelcontextprotocol/inspector@${INSPECTOR_VERSION} --cli --server-url ${URL_} --transport http --header "Authorization: Bearer $env:${VAR}" --method tools/list`
      )
    })

    it('older form for Node below 22.19: pinned v1, the URL as the first argument, no --server-url', () => {
      const bash = block('inspector', 'Inspector 1.0.2, bash')
      const powershell = block('inspector', 'Inspector 1.0.2, PowerShell')
      expect(INSPECTOR_V1_VERSION).toBe('1.0.2')
      expect(bash).toBe(`npx @modelcontextprotocol/inspector@1.0.2 --cli ${URL_} --transport http --header "Authorization: Bearer $${VAR}" --method tools/list`)
      expect(powershell).toContain(`--cli ${URL_} --transport http --header "Authorization: Bearer $env:${VAR}"`)
      expect(bash + powershell).not.toContain('--server-url')
    })

    it('says that dropping --cli opens the UI, and never writes an unpinned inspector command', () => {
      expect(guide('inspector').notes.join(' ')).toContain('without --cli opens the Inspector UI')
      for (const b of guide('inspector').blocks) expect(b.text).toMatch(/inspector@\d+\.\d+\.\d+ /)
    })
  })

  describe('Claude Code', () => {
    it('claude mcp add with --transport http and --header before the name and URL positions, using the slug as the name', () => {
      expect(block('claude-code', 'bash')).toBe(`claude mcp add --transport http ${SLUG} ${URL_} --header "Authorization: Bearer $${VAR}"`)
      expect(block('claude-code', 'PowerShell')).toBe(`claude mcp add --transport http ${SLUG} ${URL_} --header "Authorization: Bearer $env:${VAR}"`)
    })

    it('.mcp.json uses type http and ${VAR} expansion in the header, so no key is in the file', () => {
      const json = JSON.parse(block('claude-code', '.mcp.json'))
      expect(json).toEqual({ mcpServers: { [SLUG]: { type: 'http', url: URL_, headers: { Authorization: `Bearer \${${VAR}}` } } } })
    })
  })

  describe('Cursor', () => {
    it('.cursor/mcp.json: url and headers with ${env:VAR}, and no type field', () => {
      const json = JSON.parse(block('cursor', '.cursor/mcp.json'))
      expect(json).toEqual({ mcpServers: { [SLUG]: { url: URL_, headers: { Authorization: `Bearer \${env:${VAR}}` } } } })
    })
  })

  describe('VS Code', () => {
    it('.vscode/mcp.json: a hidden promptString input, and a server of type http that uses it', () => {
      const json = JSON.parse(block('vscode', '.vscode/mcp.json'))
      const input = json.inputs[0]
      expect(input).toMatchObject({ type: 'promptString', password: true })
      expect(typeof input.description).toBe('string')
      expect(json.servers[SLUG]).toEqual({ type: 'http', url: URL_, headers: { Authorization: `Bearer \${input:${input.id}}` } })
    })
  })

  it('a different project gets its own URL, name and variable throughout', () => {
    const other = JSON.stringify(buildGuides({ url: 'https://gw.example.com/mcp/3d-shop', slug: '3d-shop' }))
    expect(other).toContain('https://gw.example.com/mcp/3d-shop')
    expect(other).toContain('P_3D_SHOP_MCP_KEY')
    expect(other).not.toContain(SLUG)
    expect(other).not.toContain(VAR)
  })
})
