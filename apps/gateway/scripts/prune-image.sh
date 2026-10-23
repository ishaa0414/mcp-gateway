#!/bin/sh
# Removes from the deployed gateway folder what the gateway never loads at runtime. The Dockerfile runs it in /out.
# Explicit path patterns only, never a package name on its own. check-image.sh (run by CI) fails if any of it comes back.
set -eu

# Prisma query compilers for other databases, and the "small" PostgreSQL build: the generated client
# (packages/db/src/generated/client/internal/class.ts) imports only query_compiler_fast_bg.postgresql.
find node_modules/.pnpm -type f -path '*/@prisma/client/runtime/*' \
  \( -name 'query_compiler_*_bg.cockroachdb.*' -o -name 'query_compiler_*_bg.mysql.*' -o -name 'query_compiler_*_bg.sqlite.*' \
     -o -name 'query_compiler_*_bg.sqlserver.*' -o -name 'query_compiler_small_bg.postgresql.*' \) -delete

# Source maps and type declarations: Node loads neither (nothing here runs with --enable-source-maps).
find . -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete

# Markdown (README, CHANGELOG), except licence files.
find . -type f -iname '*.md' ! -iname 'LICENSE*' ! -iname 'NOTICE*' -delete

# Our own workspace packages: sources, the Prisma folder (schema, migrations, seed script), tests and seed code.
for pkg in node_modules/.pnpm/@mcp-gateway+*/node_modules/@mcp-gateway/*; do
  [ -d "$pkg" ] || continue
  rm -rf "$pkg/src" "$pkg/prisma"
  find "$pkg" -type f \( -name '*.test.*' -o -name '*seed*' \) -delete
done
