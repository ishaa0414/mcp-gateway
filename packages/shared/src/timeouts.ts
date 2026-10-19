/**
 * Upstream call timeouts, in one place so the gateway and the dashboard cannot disagree.
 * The gateway gives each upstream call `TOOL_CALL_TIMEOUT_MS` (default below); the dashboard's
 * playground waits for the gateway that long plus a margin for the hop itself.
 */

/** One deadline for a whole upstream call (DNS, connect, redirects, reading the body). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 15_000

/** Extra time the dashboard allows the gateway beyond its upstream timeout (network, signing, checks, formatting). */
export const PLAYGROUND_GATEWAY_MARGIN_MS = 5_000

/** How long the dashboard waits for a playground answer from the gateway. */
export const playgroundRequestTimeoutMs = (toolCallTimeoutMs: number): number => toolCallTimeoutMs + PLAYGROUND_GATEWAY_MARGIN_MS
