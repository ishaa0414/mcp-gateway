import { createServer, type ServerResponse } from 'node:http'

// A fake upstream API on a fixed local port. The gateway calls it (it is allowed to reach local addresses in e2e only),
// and tests read back what arrived through /__requests.
const port = Number(process.env['FIXTURE_PORT'] ?? 4200)

interface Recorded {
  method: string
  url: string
  accept: string | undefined
}
let requests: Recorded[] = []

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture')

  if (url.pathname === '/__requests') return json(res, 200, requests)
  if (url.pathname === '/__reset') {
    requests = []
    return json(res, 200, { ok: true })
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true })

  requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', accept: req.headers['accept'] })

  const pet = url.pathname.match(/^\/pet\/(\d+)$/)
  if (req.method === 'GET' && pet) return json(res, 200, { id: Number(pet[1]), name: `fixture-pet-${pet[1]}`, status: 'available' })
  if (req.method === 'GET' && url.pathname === '/pet/findByStatus') {
    return json(res, 200, [{ id: 1, name: 'fixture-pet-1', status: url.searchParams.get('status') ?? 'available' }])
  }
  if (req.method === 'POST' && url.pathname === '/pet') return json(res, 200, { id: 99, name: 'created', status: 'available' })
  json(res, 404, { message: 'not found' })
}).listen(port, '127.0.0.1', () => console.log(`fixture upstream on http://127.0.0.1:${port}`))
