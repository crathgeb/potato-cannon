import { countTicketsInPhase, getTicket, updateTicket } from "../../stores/ticket.store.js";
import { getProjectById } from "../../stores/project.store.js";
import { getDatabase } from "../../stores/db.js";
import { eventBus } from "../../utils/event-bus.js";
import { getPhaseConfig } from "./phase-config.js";
import type { SessionService } from "./index.js";

const EXCLUDED_PHASES = ["Ideas", "Done"];

/** Tracks phases currently being drained to prevent re-entrant cascades. */
const drainingPhases = new Set<string>();

export function isPhaseAtWipLimit(projectId: string, phase: string): boolean {
  if (EXCLUDED_PHASES.includes(phase)) return false;

  const project = getProjectById(projectId);
  const limit = project?.wipLimits?.[phase];
  if (!limit) return false;

  const count = countTicketsInPhase(projectId, phase);
  return count >= limit;
}

export function getWipStatus(
  projectId: string,
  phase: string
): { current: number; limit: number | null; atLimit: boolean } {
  const project = getProjectById(projectId);
  const limit = project?.wipLimits?.[phase] ?? null;
  const count = countTicketsInPhase(projectId, phase);
  return {
    current: count,
    limit,
    atLimit: limit !== null && count >= limit,
  };
}

export function setupWipDrainListener(sessionService: SessionService): void {
  eventBus.on(
    "ticket:moved",
    async (data: { projectId: string; ticketId: string; from: string; to: string }) => {
      const { projectId, from: departedPhase } = data;

      // Re-entrancy guard: draining a pending ticket emits ticket:moved,
      // which would trigger this handler again. Skip if already draining.
      const drainKey = `${projectId}:${departedPhase}`;
      if (drainingPhases.has(drainKey)) return;

      const project = getProjectById(projectId);
      const limit = project?.wipLimits?.[departedPhase];
      if (!limit) return;

      const db = getDatabase();
      const pendingRows = db
        .prepare(
          `SELECT id FROM tickets
           WHERE project_id = ? AND pending_phase = ? AND archived = 0
           ORDER BY updated_at ASC
           LIMIT 1`
        )
        .all(projectId, departedPhase) as { id: string }[];

      if (pendingRows.length === 0) return;

      const currentCount = countTicketsInPhase(projectId, departedPhase);
      if (currentCount >= limit) return;

      const pendingTicketId = pendingRows[0].id;
      const pendingTicket = getTicket(projectId, pendingTicketId);
      const oldPhase = pendingTicket.phase;

      console.log(
        `[wipDrain] Space opened in ${departedPhase}, advancing ticket ${pendingTicketId}`
      );

      drainingPhases.add(drainKey);
      try {
        const ticket = await updateTicket(projectId, pendingTicketId, {
          phase: departedPhase,
          pendingPhase: null,
        });

        eventBus.emit("ticket:updated", { projectId, ticket });
        eventBus.emit("ticket:moved", {
          projectId,
          ticketId: pendingTicketId,
          from: oldPhase,
          to: departedPhase,
        });

        const phaseConfig = await getPhaseConfig(projectId, departedPhase);
        if (phaseConfig?.workers && phaseConfig.workers.length > 0) {
          if (project?.path) {
            sessionService
              .spawnForTicket(projectId, pendingTicketId, departedPhase, project.path)
              .catch((error: Error) => {
                console.error(
                  `[wipDrain] Failed to spawn session for ${pendingTicketId}: ${error.message}`
                );
              });
          }
        }
      } finally {
        drainingPhases.delete(drainKey);
      }
    }
  );
}
