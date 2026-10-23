#!/bin/sh
# Checks what is inside the gateway image: no seed code, tests, sources, maps, type declarations, Prisma tooling or
# query compilers for other databases, and a ceiling on the size of the files. CI runs it inside the image:
#   docker run --rm -i --entrypoint sh mcp-gateway:ci -s < apps/gateway/scripts/check-image.sh
# It also runs against any deployed folder: APP=/path/to/folder sh apps/gateway/scripts/check-image.sh
APP=${APP:-/app}
# Total size of the files under $APP, in bytes (50 MiB). The image is about 34 MB; this leaves room for a few new dependencies.
MAX_BYTES=${MAX_BYTES:-52428800}
failed=0

# none "<what must not be there>" <find arguments>: lists up to 5 matches and fails the run if there are any.
none() {
  what=$1
  shift
  found=$(find "$@" 2>/dev/null | head -5)
  if [ -n "$found" ]; then
    echo "FAIL: found $what"
    echo "$found" | sed 's/^/        /'
    failed=1
  else
    echo "ok:   no $what"
  fi
}

# A workspace package is node_modules/@mcp-gateway/<name>; the folder around it (.pnpm/@mcp-gateway+db@.../) also holds that package's third-party dependencies.
none "seed code in the workspace packages" "$APP" -type f -path '*/node_modules/@mcp-gateway/*' -name '*seed*'
none "test files in the workspace packages" "$APP" -type f -path '*/node_modules/@mcp-gateway/*' -name '*.test.*'
none "src/ or prisma/ folders in the workspace packages" "$APP/node_modules/.pnpm" -maxdepth 5 -type d \( -path '*@mcp-gateway/*/src' -o -path '*@mcp-gateway/*/prisma' \)
none "source maps" "$APP" -type f -name '*.map'
none "type declarations" "$APP" -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \)
none "markdown other than licences" "$APP" -type f -iname '*.md' ! -iname 'LICENSE*' ! -iname 'NOTICE*'
none "Prisma query compilers for other databases, or the small PostgreSQL build" "$APP" -type f -name 'query_compiler_*' \
  \( -name '*cockroachdb*' -o -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' -o -name 'query_compiler_small_*' \)
none "Prisma CLI toolchain (prisma, Studio, pglite)" "$APP/node_modules/.pnpm" -maxdepth 1 \
  \( -name 'prisma@*' -o -name '@prisma+studio-core*' -o -name '@prisma+dev@*' -o -name '@electric-sql+pglite*' \)

# The gateway must import the openapi-tools runtime subpath, not the main entry (which loads the spec parser).
main_entry=$(grep -rlE "from '@mcp-gateway/openapi-tools'" "$APP/dist" 2>/dev/null | head -5)
if [ -n "$main_entry" ]; then
  echo "FAIL: the compiled gateway imports the openapi-tools main entry:"
  echo "$main_entry" | sed 's/^/        /'
  failed=1
else
  echo "ok:   the compiled gateway imports only the openapi-tools runtime"
fi

bytes=$(find "$APP" -type f -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }')
echo "size: $bytes bytes of files under $APP (limit $MAX_BYTES)"
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  echo "FAIL: the image is over its size limit; see docs/DECISIONS.md, 'Pruning the gateway image'"
  failed=1
fi

exit "$failed"
