import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Settings2, Bot } from 'lucide-react'
import { SwimlaneColorPicker } from './SwimlaneColorPicker'
import { WorkerTree, useHasAnswerBot } from './WorkerTree'
import { AgentPromptEditor } from './AgentPromptEditor'

interface SwimlaneBacksideProps {
  projectId: string
  phase: string
  currentColor: string | undefined
  onColorChange: (color: string | null) => void
  wipLimit: number | undefined
  onWipLimitChange: (limit: number | null) => void
  disabled?: boolean
}

export function SwimlaneBackside({
  projectId,
  phase,
  currentColor,
  onColorChange,
  wipLimit,
  onWipLimitChange,
  disabled
}: SwimlaneBacksideProps) {
  // Agent editor state
  const [selectedAgent, setSelectedAgent] = useState<{
    agentType: string
    agentName: string
    model?: string
  } | null>(null)

  const supportsWip = !['Ideas', 'Done'].includes(phase)
  const hasAnswerBot = useHasAnswerBot(projectId, phase)

  // Local state for WIP input to avoid reset on every keystroke
  const [localWip, setLocalWip] = useState<string>(wipLimit != null ? String(wipLimit) : '')
  const localWipRef = useRef(localWip)
  localWipRef.current = localWip

  // Sync from prop when it changes externally (not from our own edits)
  const isFocusedRef = useRef(false)
  useEffect(() => {
    if (!isFocusedRef.current) {
      setLocalWip(wipLimit != null ? String(wipLimit) : '')
    }
  }, [wipLimit])

  const commitWipValue = useCallback(() => {
    const val = localWipRef.current
    if (val === '') {
      onWipLimitChange(null)
    } else {
      const num = parseInt(val, 10)
      if (!isNaN(num) && num >= 1) {
        onWipLimitChange(num)
      }
    }
  }, [onWipLimitChange])

  const handleAgentClick = useCallback((agentType: string, agentName: string, model?: string) => {
    setSelectedAgent({ agentType, agentName, model })
  }, [])

  const handleCloseEditor = useCallback(() => {
    setSelectedAgent(null)
  }, [])

  return (
    <>
      <div className="h-full flex flex-col p-4">
        {/* Header */}
        <div className="flex items-center gap-2 pb-4 border-b border-border">
          <Settings2 className="h-4 w-4 text-text-muted" />
          <h3 className="text-text-secondary font-semibold text-[13px]">
            {phase} Settings
          </h3>
        </div>

        {/* Configuration options */}
        <div className="flex-1 overflow-y-auto py-4 space-y-6">
          {/* Color setting */}
          <div className="space-y-3">
            <label className="text-xs text-text-muted uppercase tracking-wider">
              Column Color
            </label>
            <SwimlaneColorPicker
              value={currentColor}
              onChange={onColorChange}
              disabled={disabled}
            />
          </div>

          {/* WIP Limit setting */}
          {supportsWip && (
            <div className="space-y-3">
              <label className="text-xs text-text-muted uppercase tracking-wider">
                WIP Limit
              </label>
              <input
                type="number"
                min="1"
                placeholder="No limit"
                value={localWip}
                onChange={(e) => setLocalWip(e.target.value)}
                onFocus={() => { isFocusedRef.current = true }}
                onBlur={() => {
                  isFocusedRef.current = false
                  commitWipValue()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitWipValue()
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                disabled={disabled}
                className="wip-input w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-accent"
              />
              <p className="text-[11px] text-text-muted">
                Max tickets in this column. Leave empty for no limit.
              </p>
            </div>
          )}

          {/* Worker tree (excludes answerBot) */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-xs text-text-muted uppercase tracking-wider">
              Phase Workers
            </label>
            <div className="p-3 rounded-lg bg-bg-tertiary/50 border border-border">
              <WorkerTree
                projectId={projectId}
                phase={phase}
                onAgentClick={handleAgentClick}
                filter={(w) => w.type !== 'answerBot'}
                emptyMessage="No workers configured for this phase"
              />
            </div>
          </div>

          {/* Answer Bot (separate section) */}
          {hasAnswerBot && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs text-text-muted uppercase tracking-wider">
                <Bot className="h-3 w-3" />
                Answer Bot
              </label>
              <p className="text-[11px] text-text-muted -mt-1">
                Runs automatically to answer questions when automation is enabled.
              </p>
              <div className="p-3 rounded-lg bg-bg-tertiary/50 border border-border">
                <WorkerTree
                  projectId={projectId}
                  phase={phase}
                  onAgentClick={handleAgentClick}
                  filter={(w) => w.type === 'answerBot'}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Agent Prompt Editor Modal - Portaled to body to escape transform context */}
      {selectedAgent && createPortal(
        <AgentPromptEditor
          projectId={projectId}
          agentType={selectedAgent.agentType}
          agentName={selectedAgent.agentName}
          model={selectedAgent.model}
          open={true}
          onClose={handleCloseEditor}
        />,
        document.body
      )}
    </>
  )
}
