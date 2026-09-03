import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Check, Copy, FileText, Loader2, Pencil, Save, X } from 'lucide-react'
import { renderMarkdown } from '@/lib/markdown'
import { api } from '@/api/client'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ArtifactChat } from './ArtifactChat'
import { ArtifactEditor } from './ArtifactEditor'
import { useUpdateArtifact } from '@/hooks/queries'
import type { Artifact } from '@potato-cannon/shared'

interface ArtifactViewerFullProps {
  projectId: string
  ticketId: string
  artifact: Artifact | null
  onClose: () => void
}

export function ArtifactViewerFull({
  projectId,
  ticketId,
  artifact,
  onClose
}: ArtifactViewerFullProps) {
  const [content, setContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'document' | 'chat'>('document')
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  const [isStuck, setIsStuck] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const updateArtifact = useUpdateArtifact(projectId, ticketId)

  const hasUnsavedChanges = isEditing && editContent !== content

  // Detect when sticky header becomes stuck
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const scrollRoot = sentinel.closest('[data-slot="scroll-area-viewport"]')
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { root: scrollRoot as Element, threshold: 0 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [artifact])

  const handleStartEdit = useCallback(() => {
    setEditContent(content)
    setIsEditing(true)
  }, [content])

  const handleCancelEdit = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowDiscardDialog(true)
    } else {
      setIsEditing(false)
    }
  }, [hasUnsavedChanges])

  const handleDiscardChanges = useCallback(() => {
    setShowDiscardDialog(false)
    setIsEditing(false)
  }, [])

  const handleSave = useCallback(async () => {
    if (!artifact) return

    try {
      const result = await updateArtifact.mutateAsync({
        filename: artifact.filename,
        content: editContent,
      })
      setContent(editContent)
      setIsEditing(false)
      if (result.wroteThrough === false) {
        toast.warning('Saved to Cannon, but failed to write through to the real file', {
          description: 'An agent reading the actual file on disk will not see this edit.',
        })
      } else {
        toast.success('Artifact saved')
      }
    } catch (err) {
      toast.error('Failed to save artifact')
    }
  }, [artifact, editContent, updateArtifact])

  // Clean up copy timeout on unmount
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    navigator.clipboard.writeText(content)
      .then(() => {
        setCopied(true)
        toast.success('Copied to clipboard!')
      })
      .catch(() => {
        toast.error('Failed to copy to clipboard')
      })
  }

  // Fetch artifact content when artifact changes
  useEffect(() => {
    if (!artifact) {
      setContent('')
      setError(null)
      return
    }

    setIsLoading(true)
    setError(null)
    setContent('')

    api
      .getTicketArtifact(projectId, ticketId, artifact.filename)
      .then((text) => {
        setContent(text)
      })
      .catch((err) => {
        console.error('Failed to fetch artifact:', err)
        setError(err instanceof Error ? err.message : 'Failed to fetch artifact')
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [projectId, ticketId, artifact])

  // Render markdown content
  const renderedContent = useMemo(() => {
    if (!content) return ''
    return renderMarkdown(content)
  }, [content])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEditing) {
          handleCancelEdit()
        } else {
          onClose()
        }
      }
    }

    if (artifact) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [artifact, onClose, isEditing, handleCancelEdit])

  // Reset edit state when artifact changes
  useEffect(() => {
    setIsEditing(false)
    setEditContent('')
    setShowDiscardDialog(false)
  }, [artifact?.filename])

  if (!artifact) return null

  return (
    <>
    <div
      className="fullscreen-modal fixed inset-0 z-50 bg-black/80"
    >
      <div className="bg-bg-secondary w-full h-full flex flex-col overflow-hidden">
        {/* Mobile Tabs - visible only below md breakpoint */}
        <div className="md:hidden border-b border-border shrink-0">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'document' | 'chat')}>
            <TabsList className="w-full">
              <TabsTrigger value="document" className="flex-1">Document</TabsTrigger>
              <TabsTrigger value="chat" className="flex-1">Chat</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Content area - split pane */}
        <div className="flex-1 flex min-h-0">
          {/* Left pane - Artifact content */}
          <div className={cn(
            "flex-1 md:w-[70%] border-r border-border flex flex-col min-w-0",
            activeTab !== 'document' && 'hidden md:flex'
          )}>
            <div className="group/content flex-1 min-h-0 flex flex-col bg-bg-primary">
              <ScrollArea className="flex-1 min-h-0">
                <div className="py-0 px-0 md:py-8 md:px-8">
                  <div ref={sentinelRef} className="h-0" />
                  <div className={cn(
                    "sticky top-0 z-10 bg-bg-primary transition-[border-color] duration-150",
                    isStuck
                      ? "border-b border-border md:-mx-8 md:px-8"
                      : "border-b border-transparent"
                  )}>
                    <div className={cn(
                      "mx-auto max-w-5xl px-4 md:px-0",
                      isStuck ? "py-2.5" : "pt-4 md:pt-0 pb-3"
                    )}>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-text-muted shrink-0" />
                        <span className="text-sm font-semibold text-text-primary truncate">
                          {artifact.filename}
                        </span>
                        {artifact.type && (
                          <Badge variant="outline" className="shrink-0">
                            {artifact.type}
                          </Badge>
                        )}
                        {isStuck && (
                          <div className="ml-auto flex items-center gap-1 shrink-0">
                            {isEditing ? (
                              <>
                                <Button size="sm" variant="ghost" onClick={handleCancelEdit} className="h-7 px-2 text-xs">
                                  <X className="h-3.5 w-3.5 mr-1" />
                                  Cancel
                                </Button>
                                <Button size="sm" onClick={handleSave} disabled={!hasUnsavedChanges || updateArtifact.isPending} className="h-7 px-2 text-xs">
                                  <Save className="h-3.5 w-3.5 mr-1" />
                                  {updateArtifact.isPending ? 'Saving...' : 'Save'}
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button size="sm" variant="ghost" onClick={handleCopy} disabled={isLoading || !!error || !content} aria-label="Copy to clipboard" className="h-7 px-2 text-xs">
                                  {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                                  {copied ? 'Copied' : 'Copy'}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={handleStartEdit} disabled={isLoading || !!error} className="h-7 px-2 text-xs">
                                  <Pencil className="h-3.5 w-3.5 mr-1" />
                                  Edit
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {!isStuck && (
                        <div className="flex items-center gap-2 mt-1">
                          {artifact.description && (
                            <p className="text-xs text-text-muted truncate min-w-0">{artifact.description}</p>
                          )}
                          <div className="ml-auto flex items-center gap-1 shrink-0">
                            {isEditing ? (
                              <>
                                <Button size="sm" variant="ghost" onClick={handleCancelEdit} className="h-7 px-2 text-xs">
                                  <X className="h-3.5 w-3.5 mr-1" />
                                  Cancel
                                </Button>
                                <Button size="sm" onClick={handleSave} disabled={!hasUnsavedChanges || updateArtifact.isPending} className="h-7 px-2 text-xs">
                                  <Save className="h-3.5 w-3.5 mr-1" />
                                  {updateArtifact.isPending ? 'Saving...' : 'Save'}
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button size="sm" variant="ghost" onClick={handleCopy} disabled={isLoading || !!error || !content} aria-label="Copy to clipboard" className="h-7 px-2 text-xs">
                                  {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                                  {copied ? 'Copied' : 'Copy'}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={handleStartEdit} disabled={isLoading || !!error} className="h-7 px-2 text-xs">
                                  <Pencil className="h-3.5 w-3.5 mr-1" />
                                  Edit
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  {isEditing ? (
                    <div className="mx-auto max-w-5xl bg-bg-secondary md:rounded-lg md:shadow-lg overflow-hidden"
                      style={{ height: 'calc(100vh - 120px)' }}
                    >
                      <ArtifactEditor
                        value={editContent}
                        onChange={setEditContent}
                        filename={artifact.filename}
                      />
                    </div>
                  ) : (
                    <div className="relative mx-auto max-w-5xl bg-bg-secondary md:rounded-lg md:shadow-lg p-4 md:p-12">
                      {isLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
                        </div>
                      ) : error ? (
                        <div className="text-sm text-accent-red py-4">{error}</div>
                      ) : content ? (
                        <div
                          className="prose prose-invert max-w-none text-text-secondary
                            [&_p]:my-4 [&_ul]:my-4 [&_ol]:my-4 [&_li]:my-0
                            [&_a]:text-accent [&_a]:no-underline hover:[&_a]:underline
                            [&_code]:bg-bg-tertiary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:border [&_code]:border-border
                            [&_pre]:bg-bg-tertiary [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:overflow-x-auto
                            [&_pre_code]:border-0 [&_pre_code]:p-0 [&_pre_code]:bg-transparent
                            [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-text-primary [&_h1]:mt-8 [&_h1]:mb-4
                            [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-text-primary [&_h2]:mt-6 [&_h2]:mb-3
                            [&_h3]:text-lg [&_h3]:font-medium [&_h3]:text-text-primary [&_h3]:mt-5 [&_h3]:mb-2
                            [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:bg-bg-tertiary/50 [&_blockquote]:py-2 [&_blockquote]:pr-4 [&_blockquote]:rounded-r
                            [&_table]:w-full [&_th]:text-left [&_th]:p-2 [&_th]:border-b [&_th]:border-border
                            [&_td]:p-2 [&_td]:border-b [&_td]:border-border"
                          dangerouslySetInnerHTML={{ __html: renderedContent }}
                        />
                      ) : (
                        <p className="text-sm text-text-muted italic py-4">No content</p>
                      )}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          {/* Right pane - Chat */}
          <div className={cn(
            "w-full md:w-[30%] flex flex-col min-h-0",
            activeTab !== 'chat' && 'hidden md:flex'
          )}>
            <ArtifactChat
              projectId={projectId}
              ticketId={ticketId}
              artifactFilename={artifact.filename}
              onClose={isEditing && hasUnsavedChanges ? () => setShowDiscardDialog(true) : onClose}
            />
          </div>
        </div>
      </div>
    </div>

      <Dialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to discard them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDiscardDialog(false)}>
              Keep Editing
            </Button>
            <Button variant="destructive" onClick={handleDiscardChanges}>
              Discard Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
