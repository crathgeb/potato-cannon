import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DetailsTab } from './DetailsTab'

// Mock queries
vi.mock('@/hooks/queries', () => ({
  useUpdateTicket: () => ({ mutate: vi.fn(), isPending: false }),
  useTicketArtifacts: () => ({ data: [] }),
  useSessions: () => ({ data: [] }),
  useProjects: () => ({ data: [] }),
  useSessionLog: () => ({ data: null, isLoading: false }),
}))

// Mock markdown renderer
vi.mock('@/lib/markdown', () => ({
  renderMarkdown: (text: string) => `<p>${text}</p>`,
}))

// Mock ArtifactViewerFull
vi.mock('./ArtifactViewerFull', () => ({
  ArtifactViewerFull: () => null,
}))

// Mock UI components that use Radix
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: () => null,
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('DetailsTab - Block Reason in History', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('should display reason for a history entry that has one', () => {
    const history = [
      { phase: 'Ideas', at: '2026-01-01T00:00:00.000Z' },
      { phase: 'Build', at: '2026-01-02T00:00:00.000Z' },
      { phase: 'Review', at: '2026-01-03T00:00:00.000Z', reason: 'Ralph loop exhausted max attempts (3)' },
    ]

    render(
      <DetailsTab
        projectId="proj-1"
        ticketId="POT-1"
        description="Test"
        history={history}
      />
    )

    expect(screen.getByText('Ralph loop exhausted max attempts (3)')).toBeTruthy()
  })

  it('should not display reason text for entries without reason', () => {
    const history = [
      { phase: 'Ideas', at: '2026-01-01T00:00:00.000Z' },
      { phase: 'Build', at: '2026-01-02T00:00:00.000Z' },
    ]

    render(
      <DetailsTab
        projectId="proj-1"
        ticketId="POT-1"
        description="Test"
        history={history}
      />
    )

    // Both phases should render, but no amber reason text
    expect(screen.getByText('Ideas')).toBeTruthy()
    expect(screen.getByText('Build')).toBeTruthy()

    const container = screen.getByText('Ideas').closest('.space-y-6')!
    const reasonEl = container.querySelector('.text-amber-400')
    expect(reasonEl).toBeNull()
  })
})
