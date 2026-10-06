export {}

// Ensure worker threads use the test DB URL (set by global-setup.ts)
// globalThis.__prisma must be cleared so the db singleton re-initialises with the test URL.
globalThis.__prisma = undefined
