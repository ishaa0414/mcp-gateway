'use client'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface CopyButtonProps {
  value: string
  label?: string
  className?: string
}

export function CopyButton({ value, label = 'Copy', className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      // Clipboard access can be blocked (insecure origin, permissions); the text stays selectable.
      setState('failed')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} className={className}>
      {state === 'copied' ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : label}
    </Button>
  )
}
