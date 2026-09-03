# Potato Cannon Web UI

React-based web interface for the Potato Cannon ticket management system.

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | React 19 with React Compiler |
| Build | Vite 6 |
| Styling | Tailwind CSS 4 |
| Routing | TanStack Router |
| State (server) | TanStack Query |
| State (client) | Zustand |
| UI Components | Radix UI primitives |
| Icons | Lucide React |
| Drag & Drop | dnd-kit |
| Desktop | Electron (optional) |

## Project Structure

```
src/
├── api/          # API client functions
├── components/
│   ├── ui/       # Base UI components (shadcn-style)
│   ├── layout/   # App layout (sidebar, tabs)
│   ├── board/    # Kanban board components
│   ├── brainstorm/
│   ├── configure/ # Configuration UI components
│   ├── ticket-detail/
│   ├── sessions/
│   ├── logs/
│   └── templates/
├── hooks/        # Custom React hooks
├── lib/          # Utilities (cn, etc.)
├── routes/       # TanStack Router file-based routes
└── stores/       # Zustand stores
```

## Development

```bash
npm run dev        # Start dev server (proxies to daemon on :3131)
npm run build      # Type-check and build for production
npm run typecheck  # TypeScript check only
npm run lint       # ESLint
```

## Conventions

### Responsive Design

**Use container queries instead of media queries for responsive components.**

```css
/* PREFERRED - Container queries */
.component {
  container-type: inline-size;
}

@container (max-width: 640px) {
  .component__child {
    /* mobile styles */
  }
}

/* AVOID - Media queries for component-level responsiveness */
@media (max-width: 640px) {
  .component__child {
    /* don't do this */
  }
}
```

Container queries allow components to respond to their container's size rather than the viewport, making them more reusable and predictable in different layout contexts.

### Styling

- Use Tailwind CSS utility classes as the primary styling approach
- Custom CSS goes in `src/index.css` using CSS variables defined in `@theme`
- Use BEM-style naming for custom CSS classes (e.g., `.brand-logo__title`)
- Theme colors are defined as CSS variables: `--color-bg-primary`, `--color-text-primary`, `--color-accent`, etc.

### Components

- UI primitives in `components/ui/` follow shadcn/ui patterns
- Use Radix UI for accessible, unstyled primitives
- Compose complex components from smaller UI primitives
- Use `cn()` utility from `@/lib/utils` for conditional class merging

### State Management

- **Server state**: TanStack Query for API data fetching and caching
- **Client state**: Zustand for UI state (current project, modals, etc.)
- Hooks in `src/hooks/queries.ts` wrap TanStack Query for API calls

### Routing

- File-based routing with TanStack Router
- Routes defined in `src/routes/`
- Use `Link` component from `@tanstack/react-router` for navigation

### Path Aliases

Use `@/` alias for imports from `src/`:

```typescript
import { Button } from '@/components/ui/button'
import { useProjects } from '@/hooks/queries'
```

## API Integration

The dev server proxies `/api/*` and `/events/*` to the Potato Cannon daemon running on `localhost:3131`.

- REST API: `/api/*`
- Server-Sent Events: `/events/*`

## Known test failures (as of 2026-08-04)

`pnpm test` currently has 32 pre-existing failures across 4 files, unrelated to any Blocked/Brainstorm-status removal work - noting this so nobody burns time assuming they caused it:

- `src/components/board/BrainstormCard.test.tsx` (8 failures) - `TypeError: Cannot read properties of undefined (reading 'getItem')` in `BrainstormCard.tsx`'s `useState` initializer. `localStorage` isn't available in the test environment.
- `src/hooks/usePendingQuestions.test.ts` (7 failures) - same `localStorage` root cause.
- `src/stores/appStore.test.ts` (14 failures, `pendingTickets`/`ticketActivity` suites) - not yet root-caused; likely related to the same in-progress ticket-chat/pending-question work these stores support.
- `src/components/ticket-detail/ActivityTab.test.tsx` (2 failures) - assertions expect placeholder text ("No agent is running...") that doesn't match the component's current implementation.

All four sit inside the still-in-progress ticket-wide Q&A feature (`ticket-chat.routes.ts`, `adhoc-chat-runner.ts`, and related `ActivityTab`/`appStore` changes) - whoever picks that work back up will want to fix these as part of finishing it, most likely by adding a `localStorage` polyfill/mock to the test setup first.
