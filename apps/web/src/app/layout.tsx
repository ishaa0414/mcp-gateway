import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'MCP Gateway',
  description: 'Turn your REST API into a production-ready MCP server in 10 minutes',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-50 antialiased">{children}</body>
    </html>
  )
}
