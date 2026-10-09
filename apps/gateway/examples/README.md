# Phase 2 spike: what we learned about the current MCP SDK

Two files, written before any real gateway code, to learn the SDK from its installed
typings and by running it, not from memory. Neither is part of the build.

| File | What it is |
|---|---|
| `spike-server.ts` | A Fastify server with two hard-coded tools on `POST /mcp/:slug`, using the low-level `Server`. Logs the protocol revision of every request. |
| `spike-clients.ts` | Connects to it with the v2 client (three negotiation modes) and the v1 client, lists tools and calls one. |

```bash
pnpm --filter @mcp-gateway/gateway exec tsx examples/spike-server.ts      # :4100
pnpm --filter @mcp-gateway/gateway exec tsx examples/spike-clients.ts
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:4100/mcp/demo --transport http --method tools/list
```

## Findings

**Which package.** `@modelcontextprotocol/sdk` 1.32.1 is now the maintenance line (MCP spec
2025-11-25, fixes for at least six months after 2026-07-27). v2 is the current stable line, split
into `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1, and implements spec
2026-07-28. We use v2; the v1 SDK stays as a dev dependency to prove old clients still work.

**Serving model.** `createMcpHandler(factory)` builds a fresh `Server` per HTTP request, which is
exactly the shape a multi-tenant gateway needs: nothing is shared between projects, there are no
sessions and no `Mcp-Session-Id`. `toNodeHandler(handler)` from `@modelcontextprotocol/node` adapts it
to Node. In Fastify call `reply.hijack()` first (the SDK writes the raw response) and pass
`request.body` as the third argument so the body is not read twice.

**Tools without Zod.** The low-level `Server` takes `setRequestHandler('tools/list', ...)` and
`setRequestHandler('tools/call', ...)`, and a tool's `inputSchema` is a plain JSON Schema object. Our
tools come from OpenAPI at runtime, so this is the right level (`McpServer.registerTool` expects a
Standard Schema).

**Failures are results.** Returning `{ isError: true, content: [...] }` is how a tool reports a
failure to the model. Protocol errors are for malformed requests.

**The low-level server does not validate arguments.** Calling `add` with `{}` or with strings simply
reached the handler (the spike printed `NaN`). The gateway must validate against the tool's schema.
`@modelcontextprotocol/server/validators/ajv` exports `AjvJsonSchemaValidator` (so no direct `ajv`
dependency is needed): `getValidator(schema)` returns `(input) => { valid, data } | { valid: false,
errorMessage }` with readable messages such as `data/a must be number`. Compiling a schema costs about
2.5 ms and checking an input a few microseconds, so compiled validators should be cached per tool.

**Two protocol eras, one factory.** The same server answers both:

| Client | Handshake seen by the server |
|---|---|
| v2 client, default (`versionNegotiation: 'legacy'`) | `initialize` with 2025-11-25, then requests with `MCP-Protocol-Version: 2025-11-25` |
| v1 client 1.32.1 | same as above |
| MCP Inspector 2.9.0 (`--cli`) | same as above |
| v2 client, `'auto'` or `{ pin: '2026-07-28' }` | `server/discover`, then requests with `MCP-Protocol-Version: 2026-07-28` |

In practice almost every client today still opens with the 2025 handshake, which `createMcpHandler`
serves through its stateless legacy path (`legacy: 'stateless'`, the default). `legacy: 'reject'`
would turn those clients away, so we do not use it.

**Things to handle in the real gateway.**
- After `initialized`, clients send `GET` to open a standalone event stream. The spike returned 404
  only because it registered `POST`; the gateway should answer `GET` and `DELETE` with 405.
- Responses are framed as `text/event-stream` even though nothing streams.
- The factory receives `ctx.requestInfo` (the web `Request`) and `ctx.authInfo`, and
  `toNodeHandler` forwards `req.auth` as `authInfo`. The gateway can therefore build one handler at
  startup and pass the already-authenticated project through `authInfo`. The handler itself does no
  authentication.

**Inspector 2.9.0.** Requires Node >= 22.19 (the repo's engines are looser; this machine's 22.13
printed an engine warning but ran fine). CLI: `--cli <url> --transport http --header "Authorization:
Bearer <key>" --method tools/list`, or `--method tools/call --tool-name <name> --tool-arg key=value`
(numbers such as `petId=1` arrive typed, so integer parameters validate).

Web UI (`npx @modelcontextprotocol/inspector`, printed URL includes an API token): **Add Servers ->
+ Add manually**, Transport `streamable-http`, URL. The Add dialog has no header field; open the
server's **Settings -> Custom Headers -> + Add Header** for `Authorization`. Settings also has a
**Protocol Era** selector (Legacy / Auto / Modern), which is a quick way to exercise both protocol
revisions. The toggle on the server card connects; **Tools** lists them and **Execute Tool** runs one.
Headers are saved in plain text in `~/.mcp-inspector/mcp.json`.
