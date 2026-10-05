// Auth pages use useSearchParams and redirect — never statically generated.
export const dynamic = 'force-dynamic'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="mb-8 flex items-center gap-2">
        <span className="text-2xl font-bold tracking-tight">MCP Gateway</span>
      </div>
      {children}
    </div>
  )
}
