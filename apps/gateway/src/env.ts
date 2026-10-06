import { config as loadEnv } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEnv } from '@mcp-gateway/shared'
import { gatewayEnvSchema } from './env-schema.js'

// src/ (tsx dev) and dist/ (compiled) sit at the same depth, so one path works
// for both: apps/gateway/{src,dist} → apps/gateway → apps → repo root.
const here = fileURLToPath(new URL('.', import.meta.url))
export const ROOT_ENV_PATH = resolve(here, '../../../.env')

// Local development reads the repo's root .env. In a container or on a host there is no such
// file and the platform's environment variables are used; dotenv ignores the missing file, and
// variables that are already set always win.
loadEnv({ path: ROOT_ENV_PATH })

export const env = validateEnv({ schema: gatewayEnvSchema, appName: 'gateway', envFile: ROOT_ENV_PATH })
