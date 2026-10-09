// Dev runner: starts the gateway and restarts it when its source, or the built output of
// the workspace packages it uses, really changes.
//
// Why not `node --watch` or `tsx watch`: on Windows with NTFS last-access updates enabled
// (the default), the first read of a file in an hour is reported as a "change" event. Any
// process reading a watched file (Next.js compiling a page, the editor, the gateway itself)
// made `node --watch` restart the gateway in a loop. Here an event only restarts the
// gateway if the file's content hash differs from the last one we saw.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watched = [
  'src',
  '../../packages/shared/dist',
  '../../packages/crypto/dist',
  '../../packages/db/dist',
  '../../packages/openapi-tools/dist',
  '../../.env',
].map((p) => resolve(gatewayDir, p))

const DEBOUNCE_MS = 300
const hashes = new Map() // file path -> sha1 of its content

function hashOf(file) {
  try {
    if (!statSync(file).isFile()) return undefined
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined // deleted, or being written
  }
}

function snapshot(path) {
  if (!existsSync(path)) return
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) snapshot(join(path, name))
  } else {
    hashes.set(path, hashOf(path))
  }
}

let child
let pendingRestart

function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: gatewayDir, stdio: 'inherit' })
  const started = child
  started.on('exit', (code) => {
    if (child === started) {
      child = undefined
      console.error(`[dev] gateway exited with code ${code}; waiting for a file change to restart`)
    }
  })
}

function stop() {
  return new Promise((done) => {
    if (!child) return done()
    const stopping = child
    child = undefined // so its exit is not reported as a crash
    stopping.once('exit', () => done())
    stopping.kill()
  })
}

async function restart(file) {
  console.error(`[dev] ${file.replace(gatewayDir, '.')} changed, restarting`)
  await stop()
  start()
}

function onEvent(dir, name) {
  if (!name) return
  const file = resolve(dir, name)
  const hash = hashOf(file)
  if (hash === hashes.get(file)) return // access-time or metadata event: content is the same
  hashes.set(file, hash)
  clearTimeout(pendingRestart)
  pendingRestart = setTimeout(() => void restart(file), DEBOUNCE_MS)
}

for (const path of watched) snapshot(path) // before watching, so our own reads cannot trigger anything
for (const path of watched) {
  if (!existsSync(path)) continue
  const isDir = statSync(path).isDirectory()
  const dir = isDir ? path : dirname(path)
  watch(path, { recursive: isDir }, (_event, name) => onEvent(dir, isDir ? name : path.slice(dir.length + 1)))
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void stop().then(() => process.exit(0)))
}

start()
