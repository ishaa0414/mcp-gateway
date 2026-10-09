'use client'
import { useState, useTransition } from 'react'
import { updateToolEnabled, updateTool } from '@/actions/tools'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Pencil } from 'lucide-react'
import { toolNameTakenMessage, validateToolName } from '@mcp-gateway/openapi-tools/tool-name'
import { toAgentSchema } from '@mcp-gateway/openapi-tools/agent-schema'
import type { Tool } from '@mcp-gateway/db'

interface ToolListProps {
  tools: Tool[]
  projectSlug: string
}

export function ToolList({ tools, projectSlug: _projectSlug }: ToolListProps) {
  const [editingTool, setEditingTool] = useState<Tool | null>(null)
  const [isPending, startTransition] = useTransition()
  const [editError, setEditError] = useState<{ message: string; field?: 'name' } | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const nameCheck = validateToolName(editName)
  // Removed tools count too: they keep their name in the database.
  const nameTaken =
    editingTool !== null && tools.some((t) => t.id !== editingTool.id && t.name === editName)
  const nameError = !nameCheck.valid
    ? nameCheck.error
    : nameTaken
      ? toolNameTakenMessage(editName)
      : editError?.field === 'name'
        ? editError.message
        : undefined

  function openEditor(tool: Tool) {
    setEditingTool(tool)
    setEditName(tool.name)
    setEditDescription(tool.description)
    setEditError(null)
  }

  function handleToggle(tool: Tool, enabled: boolean) {
    startTransition(async () => {
      await updateToolEnabled(tool.id, enabled)
    })
  }

  function handleSave() {
    if (!editingTool) return
    startTransition(async () => {
      const res = await updateTool(editingTool.id, {
        name: editName,
        description: editDescription,
      })
      if (res.error) {
        setEditError({ message: res.error, field: res.field })
      } else {
        setEditingTool(null)
      }
    })
  }

  const active = tools.filter((t) => !t.removedAt)
  const removed = tools.filter((t) => t.removedAt)

  return (
    <>
      <div className="divide-y rounded-lg border">
        {active.map((tool) => (
          <ToolRow
            key={tool.id}
            tool={tool}
            onToggle={handleToggle}
            onEdit={() => openEditor(tool)}
          />
        ))}
        {removed.length > 0 && (
          <>
            <div className="bg-muted/40 px-4 py-2">
              <p className="text-xs font-medium text-muted-foreground">
                Removed from spec ({removed.length})
              </p>
            </div>
            {removed.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                onToggle={handleToggle}
                onEdit={() => openEditor(tool)}
              />
            ))}
          </>
        )}
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editingTool} onOpenChange={(open) => !open && setEditingTool(null)}>
        {editingTool && (
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit tool</DialogTitle>
              <DialogDescription>
                <code className="text-xs">{editingTool.method} {editingTool.path}</code>
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="basic">
              <TabsList>
                <TabsTrigger value="basic">Basic</TabsTrigger>
                <TabsTrigger value="schema">Schema preview</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="space-y-4 pt-2">
                {editError && editError.field !== 'name' && (
                  <p role="alert" className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {editError.message}
                  </p>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="toolName">Tool name</Label>
                  <Input
                    id="toolName"
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value)
                      setEditError(null)
                    }}
                    aria-invalid={nameError !== undefined}
                    aria-describedby="toolNameHelp"
                    className={`font-mono text-sm ${nameError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                  />
                  {nameError ? (
                    <p id="toolNameHelp" role="alert" className="text-xs text-destructive">
                      {nameError}
                    </p>
                  ) : (
                    <p id="toolNameHelp" className="text-xs text-muted-foreground">
                      Letters, numbers, underscores and hyphens only, up to 64 characters.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Description</Label>
                  <Textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setEditingTool(null)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={isPending || nameError !== undefined}>
                    {isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="schema" className="pt-2">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Agent sees
                    </p>
                    <pre className="max-h-64 overflow-auto rounded border bg-muted p-3 text-xs">
                      {JSON.stringify(
                        toAgentSchema(
                          editingTool.inputSchema as object,
                          editingTool.hiddenParams as object
                        ),
                        null,
                        2
                      )}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Full schema
                    </p>
                    <pre className="max-h-64 overflow-auto rounded border bg-muted p-3 text-xs">
                      {JSON.stringify(editingTool.inputSchema, null, 2)}
                    </pre>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

function ToolRow({
  tool,
  onToggle,
  onEdit,
}: {
  tool: Tool
  onToggle: (tool: Tool, enabled: boolean) => void
  onEdit: () => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Switch
        checked={tool.enabled}
        onCheckedChange={(checked) => onToggle(tool, checked)}
        disabled={!!tool.removedAt}
        aria-label={`Toggle ${tool.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-sm font-medium">{tool.name}</code>
          <Badge variant="outline" className="text-xs">
            {tool.method}
          </Badge>
          {tool.removedAt && (
            <Badge variant="warning" className="text-xs">
              Removed from spec
            </Badge>
          )}
          {!tool.enabled && !tool.removedAt && (
            <Badge variant="secondary" className="text-xs">
              Disabled
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{tool.description}</p>
      </div>
      <Button variant="ghost" size="icon" onClick={onEdit} title="Edit tool">
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
