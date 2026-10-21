import { apiKeyEnvName } from '@/lib/connect/env-name'

/**
 * The copy-paste connection snippets, one guide per client, built from a project's real URL and slug. The API
 * key is never in them: shells and config files read it from the per-project environment variable, and VS Code
 * asks for it. Formats come from each client's own documentation (the link on each guide), checked on
 * DOCS_CHECKED; they change, so a guide says where its format comes from.
 */

/** The date the formats below were last compared with the linked pages. */
export const DOCS_CHECKED = '2026-10-20'

/** A key is always `mcpg_` followed by 32 characters. A different length means the variable holds something else. */
export const KEY_LENGTH = 37

/** The Inspector builds: the current one needs Node 22.19 or newer, the v1 line needs 22.7.5 or newer. */
export const INSPECTOR_VERSION = '2.11.0'
export const INSPECTOR_V1_VERSION = '1.0.2'

export type BlockLanguage = 'bash' | 'powershell' | 'json'

export interface SnippetBlock {
  label: string
  language: BlockLanguage
  text: string
}

export interface ClientGuide {
  id: 'inspector' | 'claude-code' | 'cursor' | 'vscode'
  title: string
  docUrl: string
  docLabel: string
  /** Short lines shown above the blocks. */
  intro: string[]
  blocks: SnippetBlock[]
  /** Short lines shown below the blocks. */
  notes: string[]
}

export interface ConnectInfo {
  /** The full MCP endpoint, e.g. http://localhost:4000/mcp/petstore-demo */
  url: string
  slug: string
}

/**
 * Setting the key variable for the current shell session. Each form asks for the key without showing it, so it
 * does not land in the shell history (an `export NAME="key"` line would). The variable lasts for that terminal
 * window only.
 */
export function envBlocks(slug: string): SnippetBlock[] {
  const name = apiKeyEnvName(slug)
  return [
    { label: 'macOS / Linux (bash)', language: 'bash', text: `printf 'API key: '; read -rs ${name}; echo; export ${name}` },
    {
      label: 'Windows (PowerShell)',
      language: 'powershell',
      text: `$env:${name} = [System.Net.NetworkCredential]::new('', (Read-Host 'API key' -AsSecureString)).Password`,
    },
  ]
}

/** Checking what the variable holds, by length, so the key itself is never printed. */
export function lengthCheckBlocks(slug: string): SnippetBlock[] {
  const name = apiKeyEnvName(slug)
  return [
    { label: 'macOS / Linux (bash)', language: 'bash', text: `echo \${#${name}}` },
    { label: 'Windows (PowerShell)', language: 'powershell', text: `$env:${name}.Length` },
  ]
}

/** The troubleshooting line for a connection that fails with only "fetch failed". */
export const FETCH_FAILED_HELP = `"fetch failed" with no other detail usually means the key variable is wrong, not the network: for example a control character left by a failed paste. Check its length first; a key is ${KEY_LENGTH} characters.`

const INSPECTOR_DOC = 'https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-server-configuration.md'
const INSPECTOR_V1_DOC = 'https://github.com/modelcontextprotocol/inspector/blob/v1/main/README.md'
export const CLAUDE_CODE_DOC = 'https://code.claude.com/docs/en/mcp'
export const CURSOR_DOC = 'https://cursor.com/docs/context/mcp'
export const VSCODE_DOC = 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration'
export const CLAUDE_CONNECTORS_DOC = 'https://claude.com/docs/connectors/building/authentication'

const json = (value: unknown) => JSON.stringify(value, null, 2)

function inspector({ url, slug }: ConnectInfo): ClientGuide {
  const name = apiKeyEnvName(slug)
  const header = (shell: 'bash' | 'powershell') => `--header "Authorization: Bearer ${shell === 'bash' ? `$${name}` : `$env:${name}`}"`
  const current = (shell: 'bash' | 'powershell') =>
    `npx @modelcontextprotocol/inspector@${INSPECTOR_VERSION} --cli --server-url ${url} --transport http ${header(shell)} --method tools/list`
  const older = (shell: 'bash' | 'powershell') =>
    `npx @modelcontextprotocol/inspector@${INSPECTOR_V1_VERSION} --cli ${url} --transport http ${header(shell)} --method tools/list`

  return {
    id: 'inspector',
    title: 'MCP Inspector',
    docUrl: INSPECTOR_DOC,
    docLabel: 'Inspector server configuration',
    intro: [`Lists the project's tools from a terminal (Inspector ${INSPECTOR_VERSION}, which needs Node 22.19 or newer).`],
    blocks: [
      { label: 'macOS / Linux (bash)', language: 'bash', text: current('bash') },
      { label: 'Windows (PowerShell)', language: 'powershell', text: current('powershell') },
      { label: `Node older than 22.19: Inspector ${INSPECTOR_V1_VERSION}, bash`, language: 'bash', text: older('bash') },
      { label: `Node older than 22.19: Inspector ${INSPECTOR_V1_VERSION}, PowerShell`, language: 'powershell', text: older('powershell') },
    ],
    notes: [
      'Running the same command without --cli opens the Inspector UI.',
      `Inspector ${INSPECTOR_V1_VERSION} (the v1 line) takes the URL as its first argument; its README is ${INSPECTOR_V1_DOC}`,
    ],
  }
}

function claudeCode({ url, slug }: ConnectInfo): ClientGuide {
  const name = apiKeyEnvName(slug)
  return {
    id: 'claude-code',
    title: 'Claude Code',
    docUrl: CLAUDE_CODE_DOC,
    docLabel: 'Claude Code: connect to MCP servers',
    intro: ['Add the server once from a terminal. The shell fills in the key, and Claude Code keeps it in your local configuration (not in a project file).'],
    blocks: [
      { label: 'macOS / Linux (bash)', language: 'bash', text: `claude mcp add --transport http ${slug} ${url} --header "Authorization: Bearer $${name}"` },
      { label: 'Windows (PowerShell)', language: 'powershell', text: `claude mcp add --transport http ${slug} ${url} --header "Authorization: Bearer $env:${name}"` },
      {
        label: 'Or share it with a project: .mcp.json (Claude Code reads the key from the environment each time)',
        language: 'json',
        text: json({ mcpServers: { [slug]: { type: 'http', url, headers: { Authorization: `Bearer \${${name}}` } } } }),
      },
    ],
    notes: ['Run /mcp inside Claude Code, or claude mcp list, to check the connection. A wrong key is accepted when you add the server and fails when it connects.'],
  }
}

function cursor({ url, slug }: ConnectInfo): ClientGuide {
  const name = apiKeyEnvName(slug)
  return {
    id: 'cursor',
    title: 'Cursor',
    docUrl: CURSOR_DOC,
    docLabel: 'Cursor: Model Context Protocol',
    intro: ['Put this in .cursor/mcp.json in your project, or in ~/.cursor/mcp.json for every project.'],
    blocks: [
      {
        label: '.cursor/mcp.json',
        language: 'json',
        text: json({ mcpServers: { [slug]: { url, headers: { Authorization: `Bearer \${env:${name}}` } } } }),
      },
    ],
    notes: [`Cursor reads ${name} from its own environment, so start Cursor from a shell where it is set, or set it as a user environment variable.`],
  }
}

function vscode({ url, slug }: ConnectInfo): ClientGuide {
  const inputId = `${slug}-api-key`
  return {
    id: 'vscode',
    title: 'VS Code',
    docUrl: VSCODE_DOC,
    docLabel: 'VS Code: MCP configuration reference',
    intro: ['Put this in .vscode/mcp.json. VS Code asks for the key the first time the server starts, hides what you type, and stores it for you.'],
    blocks: [
      {
        label: '.vscode/mcp.json',
        language: 'json',
        text: json({
          inputs: [{ type: 'promptString', id: inputId, description: `API key for ${slug}`, password: true }],
          servers: { [slug]: { type: 'http', url, headers: { Authorization: `Bearer \${input:${inputId}}` } } },
        }),
      },
    ],
    notes: ['This one does not use the environment variable: VS Code has its own prompt for secrets, so the key never sits in the file.'],
  }
}

/** The guides, in the order the page shows them. */
export function buildGuides(info: ConnectInfo): ClientGuide[] {
  return [inspector(info), claudeCode(info), cursor(info), vscode(info)]
}
