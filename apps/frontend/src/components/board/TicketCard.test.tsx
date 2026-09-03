import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TicketCard } from './TicketCard'

// Mock dnd-kit
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Translate: { toString: () => '' } },
}))

// Mock queries
vi.mock('@/hooks/queries', () => ({
  useArchiveTicket: () => ({ mutate: vi.fn(), isPending: false }),
  useEpics: () => ({ data: undefined }),
}))

// Mock appStore
const mockIsTicketProcessing = vi.fn().mockReturnValue(false)
const mockIsTicketPending = vi.fn().mockReturnValue(false)
const mockIsTicketArchiving = vi.fn().mockReturnValue(false)
const mockGetTicketActivity = vi.fn().mockReturnValue(undefined)
const mockOpenTicketSheet = vi.fn()

vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      openTicketSheet: mockOpenTicketSheet,
      isTicketProcessing: mockIsTicketProcessing,
      isTicketPending: mockIsTicketPending,
      isTicketArchiving: mockIsTicketArchiving,
      getTicketActivity: mockGetTicketActivity,
      ticketSheetTicketId: 'POT-1',
    }
    return selector(state)
  },
}))

// Mock ArchiveConfirmDialog
vi.mock('@/components/ticket-detail/ArchiveConfirmDialog', () => ({
  ArchiveConfirmDialog: () => null,
  shouldShowArchiveWarning: () => false,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const baseTicket = {
  id: 'POT-1',
  title: 'Test Ticket',
  description: 'A test ticket',
  phase: 'Build',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archived: false,
  images: [],
}

describe('TicketCard - Pending Badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('should not show pending badge when ticket is not pending', () => {
    mockIsTicketPending.mockReturnValue(false)

    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    expect(screen.queryByText('?')).toBeNull()
  })

  it('should show amber ? badge when ticket is pending', () => {
    mockIsTicketPending.mockReturnValue(true)

    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    const badge = screen.getByText('?')
    expect(badge).toBeTruthy()
    expect(badge.className).toContain('text-amber-400')
  })

  it('should apply pulsating glow animation to pending badge', () => {
    mockIsTicketPending.mockReturnValue(true)

    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    const badge = screen.getByText('?')
    expect(badge.className).toContain('animate-pending-glow')
  })
})

describe('TicketCard - Processing Activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTicketActivity.mockReturnValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it('should show "Processing..." when processing with no activity text', () => {
    mockIsTicketProcessing.mockReturnValue(true)
    mockGetTicketActivity.mockReturnValue(undefined)

    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    expect(screen.getByText('Processing...')).toBeTruthy()
  })

  it('should show activity text when processing with activity', () => {
    mockIsTicketProcessing.mockReturnValue(true)
    mockGetTicketActivity.mockReturnValue('Reading documentation')

    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    expect(screen.getByText('Reading documentation')).toBeTruthy()
    expect(screen.queryByText('Processing...')).toBeNull()
  })

  it('should show pulsing dot when processing', () => {
    mockIsTicketProcessing.mockReturnValue(true)

    const { container } = render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    const dot = container.querySelector('.animate-pulse')
    expect(dot).toBeTruthy()
  })

  it('should not show processing indicator when not processing', () => {
    mockIsTicketProcessing.mockReturnValue(false)

    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    expect(screen.queryByText('Processing...')).toBeNull()
  })
})

describe('TicketCard - Pending Phase Indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTicketPending.mockReturnValue(false)
  })

  afterEach(() => {
    cleanup()
  })

  it('should show clock icon when ticket has pendingPhase', () => {
    const ticket = {
      ...baseTicket,
      pendingPhase: 'Architecture',
    }

    render(<TicketCard ticket={ticket as any} projectId="proj-1" />)

    expect(screen.getByText('Waiting for Architecture')).toBeTruthy()
  })

  it('should not show pending phase indicator when pendingPhase is undefined', () => {
    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    expect(screen.queryByText(/Waiting for/)).toBeNull()
  })

  it('should not show pending phase indicator when pending question badge is showing', () => {
    mockIsTicketPending.mockReturnValue(true)

    const ticket = {
      ...baseTicket,
      pendingPhase: 'Architecture',
    }

    render(<TicketCard ticket={ticket as any} projectId="proj-1" />)

    // The ? badge should show instead
    expect(screen.getByText('?')).toBeTruthy()
    expect(screen.queryByText('Waiting for Architecture')).toBeNull()
  })
})

describe('TicketCard - Selected State', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('should pass isSelected to ListItemCard when ticketSheetTicketId matches', () => {
    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    // The ListItemCard should receive isSelected - we verify via the rendered classes
    // Bold selected variant applies border-accent/50 and ring-1
    const card = screen.getByText('Test Ticket').closest('[class*="rounded-lg"]') as HTMLElement
    expect(card.className).toContain('border-accent/50')
    expect(card.className).toContain('ring-1')
  })

  it('should not show selected state when ticketSheetTicketId does not match', () => {
    render(<TicketCard ticket={{ ...baseTicket, id: 'POT-99' } as any} projectId="proj-1" />)

    const card = screen.getByText('Test Ticket').closest('[class*="rounded-lg"]') as HTMLElement
    expect(card.className).not.toContain('border-accent/50')
    expect(card.className).not.toContain('ring-1')
  })
})

describe('TicketCard - Processing + Selected State', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('should apply both ticket-card-processing and ticket-card-selected when processing and selected', () => {
    mockIsTicketProcessing.mockReturnValue(true)
    mockGetTicketActivity.mockReturnValue('Building...')

    // baseTicket.id is 'POT-1' which matches ticketSheetTicketId in mock store
    render(<TicketCard ticket={baseTicket as any} projectId="proj-1" />)

    const card = screen.getByText('Test Ticket').closest('[class*="rounded-lg"]') as HTMLElement
    expect(card.className).toContain('ticket-card-processing')
    expect(card.className).toContain('ticket-card-selected')
  })

  it('should not apply ticket-card-selected when processing but not selected', () => {
    mockIsTicketProcessing.mockReturnValue(true)
    mockGetTicketActivity.mockReturnValue('Building...')

    render(<TicketCard ticket={{ ...baseTicket, id: 'POT-99' } as any} projectId="proj-1" />)

    const card = screen.getByText('Test Ticket').closest('[class*="rounded-lg"]') as HTMLElement
    expect(card.className).toContain('ticket-card-processing')
    expect(card.className).not.toContain('ticket-card-selected')
  })
})
