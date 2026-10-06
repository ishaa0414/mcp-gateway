// Fails the build if any client component (directly or transitively) imports this.
// Not placed in packages/db because the gateway and worker run outside React.
import 'server-only'

export { db } from '@mcp-gateway/db'
