import type { PrismaClient } from '@mcp-gateway/db'
import { buildRequestMap, toAgentSchema } from '@mcp-gateway/openapi-tools'
import type { RequestMap } from '@mcp-gateway/openapi-tools'
import { projectConfigKey } from '@mcp-gateway/shared'
import type { AppConfig, Logger } from '../config.js'
import type { SafeRedis } from './safe-redis.js'

export type CredentialKind = 'NONE' | 'BEARER' | 'CUSTOM_HEADER' | 'QUERY_PARAM'

export interface CachedTool {
  id: string
  name: string
  description: string
  method: string
  path: string
  /** The input schema as the agent sees it (hidden parameters removed). */
  agentSchema: Record<string, unknown>
  /** Hidden parameters: argument name to its fixed value. */
  hidden: Record<string, unknown>
  requestMap: RequestMap
  /** Changes whenever the tool does; keys the compiled-validator cache. */
  version: number
}

export interface ProjectConfig {
  projectId: string
  slug: string
  upstreamBaseUrl: string
  credential: {
    type: CredentialKind
    headerName: string | null
    queryParamName: string | null
    /** Still encrypted: the plaintext only exists in memory while a call is in flight. */
    encryptedValue: string | null
  }
  /** Enabled, non-removed tools only. */
  tools: CachedTool[]
}

interface Deps {
  db: PrismaClient
  cache: SafeRedis
  config: AppConfig
  log: Logger
}

async function buildFromDatabase(slug: string, { db, log }: Deps): Promise<ProjectConfig | null> {
  const project = await db.project.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      upstreamBaseUrl: true,
      openapiSpec: true,
      upstreamCredential: true,
      tools: { where: { enabled: true, removedAt: null }, orderBy: { name: 'asc' } },
    },
  })
  if (!project) return null

  const spec = (project.openapiSpec ?? {}) as Record<string, unknown>
  const tools: CachedTool[] = []
  for (const t of project.tools) {
    const requestMap = buildRequestMap(spec, t.method, t.path)
    if (!requestMap) {
      // The operation is no longer in the stored spec; it cannot be called safely.
      log.warn({ projectId: project.id, tool: t.name }, 'tool skipped: operation not found in the stored spec')
      continue
    }
    const hiddenParams = (t.hiddenParams ?? {}) as Record<string, { value?: unknown }>
    tools.push({
      id: t.id,
      name: t.name,
      description: t.description,
      method: t.method,
      path: t.path,
      agentSchema: toAgentSchema(t.inputSchema as object, hiddenParams) as Record<string, unknown>,
      hidden: Object.fromEntries(Object.entries(hiddenParams).map(([name, cfg]) => [name, cfg?.value])),
      requestMap,
      version: t.updatedAt.getTime(),
    })
  }

  const cred = project.upstreamCredential
  return {
    projectId: project.id,
    slug: project.slug,
    upstreamBaseUrl: project.upstreamBaseUrl,
    credential: {
      type: cred?.type ?? 'NONE',
      headerName: cred?.headerName ?? null,
      queryParamName: cred?.queryParamName ?? null,
      encryptedValue: cred?.encryptedValue ?? null,
    },
    tools,
  }
}

/** A project's serving configuration: from Redis when cached, otherwise built from Postgres and cached. */
export async function loadProjectConfig(slug: string, deps: Deps): Promise<ProjectConfig | null> {
  const key = projectConfigKey(slug)

  const cached = await deps.cache.getJson<ProjectConfig>(key)
  if (cached) return cached

  const built = await buildFromDatabase(slug, deps)
  if (built) await deps.cache.setJson(key, built, deps.config.configCacheTtlSeconds)
  return built
}
