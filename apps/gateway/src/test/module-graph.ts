import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Every relative module reachable from `entry` through static `import`/`export ... from` statements, as paths under `root`. */
export function reachable(entry: string, root: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const next = resolve(dirname(file), match[1]!)
      if (existsSync(next)) queue.push(next)
    }
  }
  return [...seen].map((f) => f.slice(root.length + 1).replaceAll('\\', '/')).sort()
}

/** The package names (not relative paths) a module imports statically, e.g. `yaml` or `@apidevtools/swagger-parser`. */
export function externalImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*['"]([^./'"][^'"]*)['"]/g)) names.add(match[1]!)
  return [...names].sort()
}
