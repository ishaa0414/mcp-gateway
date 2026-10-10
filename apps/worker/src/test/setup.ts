// The db singleton lives on globalThis; clear it so it is created against the test database.
;(globalThis as { __prisma?: unknown }).__prisma = undefined
