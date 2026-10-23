// @prisma/client lists the Prisma CLI ("prisma") as an optional peer dependency. pnpm resolves it anyway and
// `pnpm deploy --prod` then ships the CLI with Studio, a local Postgres and the React packages they need: 125
// packages, 222 MB, in the gateway image. The client never loads the CLI at runtime. Packages that run the CLI
// (packages/db) still list `prisma` as their own devDependency, so generate and migrate are unaffected.
function readPackage(pkg) {
  if (pkg.name === '@prisma/client') {
    delete pkg.peerDependencies?.prisma
    delete pkg.peerDependenciesMeta?.prisma
  }
  return pkg
}

module.exports = { hooks: { readPackage } }
