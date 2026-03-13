import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardColumn } from "./BoardColumn";

// Mock dnd-kit
vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
}));

// Mock app store
vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openAddTicketModal: vi.fn(),
    }),
}));

// Mock child components that aren't relevant to tooltip tests
vi.mock("./TicketCard", () => ({
  TicketCard: () => null,
}));

vi.mock("./SwimlaneBackside", () => ({
  SwimlaneBackside: () => null,
}));

// Mock window.matchMedia (needed for Radix UI Tooltip)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Helper to render BoardColumn with tooltip provider
// Radix Tooltip requires pointer events; we use userEvent.setup with pointerEventsCheck disabled
function renderBoardColumn(props: Partial<React.ComponentProps<typeof BoardColumn>> = {}) {
  const defaultProps = {
    phase: "Build",
    tickets: [],
    projectId: "test-project",
  };

  return {
    user: userEvent.setup({ pointerEventsCheck: 0 }),
    ...render(
      <BoardColumn {...defaultProps} {...props} />
    ),
  };
}

// Helper to find the bot button (first button in the header with the bot icon)
function getBotButton() {
  const buttons = screen.getAllByRole("button");
  // The bot button is typically the first button in the component
  return buttons.find(btn => {
    const svg = btn.querySelector('svg');
    return svg && svg.className.baseVal.includes('lucide-bot');
  }) || buttons[0];
}

describe("BoardColumn tooltip", () => {
  it("shows phase description in tooltip when automated and phaseDescription is provided", async () => {
    const { user } = renderBoardColumn({
      canAutomate: true,
      isAutomated: true,
      onToggleAutomated: vi.fn(),
      phaseDescription: "AI agents implement code from the specification with review loops",
    });

    const botButton = getBotButton();
    await user.hover(botButton);

    expect(
      await screen.findByText("AI agents implement code from the specification with review loops")
    ).toBeInTheDocument();
  });

  it("shows phase description in tooltip when not automated and phaseDescription is provided", async () => {
    const { user } = renderBoardColumn({
      canAutomate: true,
      isAutomated: false,
      onToggleAutomated: vi.fn(),
      phaseDescription: "AI agents design technical architecture with adversarial review",
    });

    const botButton = getBotButton();
    await user.hover(botButton);

    expect(
      await screen.findByText("AI agents design technical architecture with adversarial review")
    ).toBeInTheDocument();
  });

  it("falls back to generic text when no phaseDescription is provided", async () => {
    const { user } = renderBoardColumn({
      canAutomate: true,
      isAutomated: true,
      onToggleAutomated: vi.fn(),
    });

    const botButton = getBotButton();
    await user.hover(botButton);

    expect(await screen.findByText("Automated")).toBeInTheDocument();
  });

  it("shows migration text regardless of phaseDescription", async () => {
    const { user } = renderBoardColumn({
      canAutomate: true,
      isAutomated: true,
      isMigrating: true,
      onToggleAutomated: vi.fn(),
      phaseDescription: "Some description",
    });

    const botButton = getBotButton();
    await user.hover(botButton);

    expect(await screen.findByText("Migration in progress...")).toBeInTheDocument();
  });
});
