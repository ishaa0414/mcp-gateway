// Builds what the e2e run starts: the gateway (and the packages it imports) and a production build of the dashboard
// in its own output folder (.next-e2e), so a build never touches the `.next` folder `next dev` uses.
import { spawnSync } from 'node:child_process'

const run = (args, env = {}) => {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['--filter', '@mcp-gateway/gateway...', 'run', 'build'])
// The dashboard validates its environment when it starts, not when it builds; NEXT_DIST_DIR is the only thing that matters here.
run(['--filter', '@mcp-gateway/web', 'run', 'build'], { NEXT_DIST_DIR: '.next-e2e' })
