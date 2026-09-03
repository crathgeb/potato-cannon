import { describe, it, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert";

import {
  waitForResponse,
  createWaitController,
  cancelWaitForResponse,
  writeQuestion,
  readQuestion,
  clearQuestion,
  writeResponse,
  readResponse,
  clearResponse,
  scanPendingResponses,
  getPendingQuestionsByProject,
} from "../chat.store.js";
import { initDatabase, getDatabase } from "../db.js";

before(() => {
  // initDatabase runs migrations including V10 which creates pending_questions
  initDatabase();
});

// ─── Helpers ─────────────────────────────────────────────────────────

const PROJECT = "test-chat-store";

/** Clean up all rows inserted by tests for this project */
function cleanup(...contextIds: string[]) {
  for (const id of contextIds) {
    clearQuestion(PROJECT, id);
  }
}

// ─── writeQuestion / readQuestion ────────────────────────────────────

describe("writeQuestion / readQuestion", () => {
  const ctx = "TICKET-1";

  afterEach(() => cleanup(ctx));

  it("should round-trip a question with all fields", () => {
    const q = {
      conversationId: "conv-1",
      question: "Pick a colour",
      options: ["red", "blue"] as string[],
      askedAt: "2026-03-08T00:00:00.000Z",
      phase: "Refinement",
      claudeSessionId: "sess-abc",
    };
    writeQuestion(PROJECT, ctx, q);

    const read = readQuestion(PROJECT, ctx);
    assert.ok(read);
    assert.strictEqual(read.conversationId, q.conversationId);
    assert.strictEqual(read.question, q.question);
    assert.deepStrictEqual(read.options, q.options);
    assert.strictEqual(read.askedAt, q.askedAt);
    assert.strictEqual(read.phase, q.phase);
    assert.strictEqual(read.claudeSessionId, q.claudeSessionId);
  });

  it("should return null options when stored as null", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-2",
      question: "Open-ended?",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
    });

    const read = readQuestion(PROJECT, ctx);
    assert.ok(read);
    assert.strictEqual(read.options, null);
  });

  it("should omit phase and claudeSessionId when not set", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-3",
      question: "Plain question",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
    });

    const read = readQuestion(PROJECT, ctx);
    assert.ok(read);
    assert.strictEqual(read.phase, undefined);
    assert.strictEqual(read.claudeSessionId, undefined);
  });

  it("should return null for non-existent question", () => {
    const read = readQuestion(PROJECT, "no-such-ticket");
    assert.strictEqual(read, null);
  });

  it("should overwrite an existing question (INSERT OR REPLACE)", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-old",
      question: "Old question",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
    });

    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-new",
      question: "New question",
      options: ["a"],
      askedAt: "2026-03-08T01:00:00.000Z",
      phase: "Build",
    });

    const read = readQuestion(PROJECT, ctx);
    assert.ok(read);
    assert.strictEqual(read.conversationId, "conv-new");
    assert.strictEqual(read.question, "New question");
    assert.deepStrictEqual(read.options, ["a"]);
    assert.strictEqual(read.phase, "Build");
  });

  it("should overwrite and clear any previous answer", () => {
    // Write question, then answer it
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-1",
      question: "First?",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
    });
    writeResponse(PROJECT, ctx, { answer: "yes" });
    assert.ok(readResponse(PROJECT, ctx));

    // Overwrite with a new question — answer column should be NULL
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-2",
      question: "Second?",
      options: null,
      askedAt: "2026-03-08T01:00:00.000Z",
    });

    assert.strictEqual(readResponse(PROJECT, ctx), null);
  });
});

// ─── Context type derivation ─────────────────────────────────────────

describe("context type derivation", () => {
  const ticketCtx = "TICKET-CTX";
  const brainstormCtx = "brain_CTX";
  const artifactCtx = "artchat_CTX";

  afterEach(() => cleanup(ticketCtx, brainstormCtx, artifactCtx));

  it("should derive 'ticket' for plain IDs", () => {
    writeQuestion(PROJECT, ticketCtx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    // getPendingQuestionsByProject only returns context_type='ticket'
    const map = getPendingQuestionsByProject();
    const ids = map.get(PROJECT) ?? [];
    assert.ok(ids.includes(ticketCtx));
  });

  it("should derive 'brainstorm' for brain_ prefix", () => {
    writeQuestion(PROJECT, brainstormCtx, {
      conversationId: "c2",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    // Should NOT appear in getPendingQuestionsByProject (tickets only)
    const map = getPendingQuestionsByProject();
    const ids = map.get(PROJECT) ?? [];
    assert.ok(!ids.includes(brainstormCtx));
  });

  it("should derive 'artifact_chat' for artchat_ prefix", () => {
    writeQuestion(PROJECT, artifactCtx, {
      conversationId: "c3",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    // Should NOT appear in getPendingQuestionsByProject (tickets only)
    const map = getPendingQuestionsByProject();
    const ids = map.get(PROJECT) ?? [];
    assert.ok(!ids.includes(artifactCtx));
  });
});

// ─── clearQuestion ───────────────────────────────────────────────────

describe("clearQuestion", () => {
  const ctx = "TICKET-CLR";

  afterEach(() => cleanup(ctx));

  it("should remove the row so readQuestion returns null", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    clearQuestion(PROJECT, ctx);
    assert.strictEqual(readQuestion(PROJECT, ctx), null);
  });

  it("should be idempotent — calling twice does not throw", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    clearQuestion(PROJECT, ctx);
    clearQuestion(PROJECT, ctx); // No-op, should not throw
    assert.strictEqual(readQuestion(PROJECT, ctx), null);
  });
});

// ─── writeResponse / readResponse ────────────────────────────────────

describe("writeResponse / readResponse", () => {
  const ctx = "TICKET-RESP";

  afterEach(() => cleanup(ctx));

  it("should return null before any response is written", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    assert.strictEqual(readResponse(PROJECT, ctx), null);
  });

  it("should return the answer after writeResponse", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    writeResponse(PROJECT, ctx, { answer: "42" });
    const resp = readResponse(PROJECT, ctx);
    assert.ok(resp);
    assert.strictEqual(resp.answer, "42");
  });

  it("should return null if no question row exists (UPDATE has no target)", () => {
    // writeResponse without a question is a no-op UPDATE
    writeResponse(PROJECT, ctx, { answer: "orphan" });
    assert.strictEqual(readResponse(PROJECT, ctx), null);
  });
});

// ─── clearResponse ───────────────────────────────────────────────────

describe("clearResponse", () => {
  const ctx = "TICKET-CLRR";

  afterEach(() => cleanup(ctx));

  it("should delete the entire row (same as clearQuestion)", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });
    writeResponse(PROJECT, ctx, { answer: "a" });

    clearResponse(PROJECT, ctx);
    assert.strictEqual(readQuestion(PROJECT, ctx), null);
    assert.strictEqual(readResponse(PROJECT, ctx), null);
  });

  it("should be idempotent — calling clearResponse then clearQuestion is safe", () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    clearResponse(PROJECT, ctx);
    clearQuestion(PROJECT, ctx); // second delete on same row — should not throw
  });
});

// ─── Answer bot resume sequence ──────────────────────────────────────
// Regression test: the answer bot writes a response, then
// resumeSuspendedTicket reads it before clearing the row.
// Previously the actual answer was never read — a hardcoded placeholder
// was passed instead.

describe("answer bot resume sequence", () => {
  const ctx = "TICKET-ABOT";

  afterEach(() => cleanup(ctx));

  it("should read the real answer before clearQuestion destroys the row", () => {
    // 1. Original agent suspends — daemon writes pending question
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-1",
      question: "Which approach?",
      options: ["A", "B"],
      askedAt: new Date().toISOString(),
      phase: "Build",
      claudeSessionId: "sess-original",
    });

    // 2. Answer bot submits answer via handleResponse → writeResponse
    writeResponse(PROJECT, ctx, { answer: "Use approach B with Redis" });

    // 3. Answer bot exits → onExit reads the answer BEFORE resuming
    const pending = readResponse(PROJECT, ctx);
    assert.ok(pending, "readResponse must return the answer before clear");
    assert.strictEqual(pending.answer, "Use approach B with Redis");

    // Also verify the question (with claudeSessionId) is still readable
    const question = readQuestion(PROJECT, ctx);
    assert.ok(question);
    assert.strictEqual(question.claudeSessionId, "sess-original");

    // 4. resumeSuspendedTicket clears both
    clearQuestion(PROJECT, ctx);
    clearResponse(PROJECT, ctx); // second delete is a no-op

    // 5. Row is gone
    assert.strictEqual(readResponse(PROJECT, ctx), null);
    assert.strictEqual(readQuestion(PROJECT, ctx), null);
  });

  it("should fall back gracefully when answer bot did not write a response", () => {
    // Question exists but answer bot crashed before writing a response
    writeQuestion(PROJECT, ctx, {
      conversationId: "conv-1",
      question: "Which approach?",
      options: null,
      askedAt: new Date().toISOString(),
    });

    const pending = readResponse(PROJECT, ctx);
    assert.strictEqual(pending, null, "readResponse should be null when no answer written");
  });
});

// ─── scanPendingResponses ────────────────────────────────────────────

describe("scanPendingResponses", () => {
  const ticket = "TICKET-SCAN";
  const brainstorm = "brain_SCAN";
  const artifact = "artchat_SCAN";

  afterEach(() => cleanup(ticket, brainstorm, artifact));

  it("should return empty array when no answered rows exist", () => {
    const results = scanPendingResponses();
    // Filter to our project only (other tests may leave data)
    const ours = results.filter((r) => r.projectId === PROJECT);
    assert.strictEqual(ours.length, 0);
  });

  it("should include tickets with answers", () => {
    writeQuestion(PROJECT, ticket, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
      phase: "Build",
    });
    writeResponse(PROJECT, ticket, { answer: "done" });

    const results = scanPendingResponses();
    const found = results.find(
      (r) => r.projectId === PROJECT && r.contextId === ticket,
    );
    assert.ok(found);
    assert.strictEqual(found.type, "ticket");
    assert.strictEqual(found.response.answer, "done");
    assert.ok(found.question);
    assert.strictEqual(found.question.question, "q");
    assert.strictEqual(found.question.phase, "Build");
  });

  it("should include brainstorms with answers", () => {
    writeQuestion(PROJECT, brainstorm, {
      conversationId: "c2",
      question: "brainstorm q",
      options: ["a", "b"],
      askedAt: "2026-03-08T00:00:00.000Z",
    });
    writeResponse(PROJECT, brainstorm, { answer: "b" });

    const results = scanPendingResponses();
    const found = results.find(
      (r) => r.projectId === PROJECT && r.contextId === brainstorm,
    );
    assert.ok(found);
    assert.strictEqual(found.type, "brainstorm");
    assert.deepStrictEqual(found.question?.options, ["a", "b"]);
  });

  it("should NOT include artifact_chat contexts", () => {
    writeQuestion(PROJECT, artifact, {
      conversationId: "c3",
      question: "artifact q",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
    });
    writeResponse(PROJECT, artifact, { answer: "artifact a" });

    const results = scanPendingResponses();
    const found = results.find(
      (r) => r.projectId === PROJECT && r.contextId === artifact,
    );
    assert.strictEqual(found, undefined);
  });

  it("should NOT include unanswered questions", () => {
    writeQuestion(PROJECT, ticket, {
      conversationId: "c1",
      question: "unanswered",
      options: null,
      askedAt: "2026-03-08T00:00:00.000Z",
    });

    const results = scanPendingResponses();
    const found = results.find(
      (r) => r.projectId === PROJECT && r.contextId === ticket,
    );
    assert.strictEqual(found, undefined);
  });
});

// ─── getPendingQuestionsByProject ────────────────────────────────────

describe("getPendingQuestionsByProject", () => {
  const ticketId1 = "TICKET-PQ1";
  const ticketId2 = "TICKET-PQ2";
  const ticketId3 = "TICKET-PQ3";
  const brainstormId = "brain_PQ";

  afterEach(() => cleanup(ticketId1, ticketId2, ticketId3, brainstormId));

  it("should return empty map when no pending questions exist", () => {
    const result = getPendingQuestionsByProject();
    const tickets = result.get(PROJECT);
    assert.ok(!tickets || tickets.length === 0);
  });

  it("should return ticket IDs with pending questions grouped by project", () => {
    writeQuestion(PROJECT, ticketId1, {
      conversationId: "conv-1",
      question: "What color?",
      options: null,
      askedAt: new Date().toISOString(),
    });
    writeQuestion(PROJECT, ticketId2, {
      conversationId: "conv-2",
      question: "What size?",
      options: ["S", "M", "L"],
      askedAt: new Date().toISOString(),
    });

    const result = getPendingQuestionsByProject();
    const tickets = result.get(PROJECT);
    assert.ok(tickets);
    assert.ok(tickets.includes(ticketId1));
    assert.ok(tickets.includes(ticketId2));
    assert.strictEqual(tickets.length, 2);
  });

  it("should not include tickets without pending questions", () => {
    writeQuestion(PROJECT, ticketId1, {
      conversationId: "conv-1",
      question: "What color?",
      options: null,
      askedAt: new Date().toISOString(),
    });

    const result = getPendingQuestionsByProject();
    const tickets = result.get(PROJECT);
    assert.ok(tickets);
    assert.ok(tickets.includes(ticketId1));
    assert.ok(!tickets.includes(ticketId2));
  });

  it("should not include brainstorm contexts", () => {
    writeQuestion(PROJECT, brainstormId, {
      conversationId: "conv-b",
      question: "brainstorm q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    const result = getPendingQuestionsByProject();
    const tickets = result.get(PROJECT) ?? [];
    assert.ok(!tickets.includes(brainstormId));
  });

  it("should exclude tickets that have answers, even though the row still exists", () => {
    // This function only feeds the 5s processing:sync heartbeat that drives
    // the "?" / "needs your input" badge - it's not what triggers resuming
    // a suspended session (writeResponse's own caller does that directly,
    // synchronously). Once a human has answered, showing them "still
    // waiting on you" during the brief window before the row is cleared by
    // resumeSuspendedTicket is the wrong UX, not a bug to preserve. This
    // test previously asserted the opposite ("row still exists, so it
    // should be included") - that was a stale assumption from earlier work,
    // not something any real caller actually depends on.
    writeQuestion(PROJECT, ticketId1, {
      conversationId: "conv-1",
      question: "Answered ticket",
      options: null,
      askedAt: new Date().toISOString(),
    });
    writeResponse(PROJECT, ticketId1, { answer: "yes" });

    const result = getPendingQuestionsByProject();
    const tickets = result.get(PROJECT) ?? [];
    assert.ok(!tickets.includes(ticketId1));
  });
});

// ─── waitForResponse ─────────────────────────────────────────────────

describe("waitForResponse", () => {
  const ctx = "brain_WAIT";

  beforeEach(() => cleanup(ctx));
  afterEach(() => {
    cancelWaitForResponse(ctx);
    cleanup(ctx);
  });

  it("should return answer and clean up the row", async () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    setTimeout(() => {
      writeResponse(PROJECT, ctx, { answer: "the answer" });
    }, 100);

    const result = await waitForResponse(PROJECT, ctx, 10000);
    assert.strictEqual(result, "the answer");

    // Row should be deleted after waitForResponse returns
    assert.strictEqual(readQuestion(PROJECT, ctx), null);
    assert.strictEqual(readResponse(PROJECT, ctx), null);
  });

  it("should throw on timeout", async () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    await assert.rejects(
      waitForResponse(PROJECT, ctx, 100), // 100ms timeout
      { message: "Timeout waiting for response" },
    );
  });

  it("should throw when abort signal is triggered", async () => {
    writeQuestion(PROJECT, ctx, {
      conversationId: "c1",
      question: "q",
      options: null,
      askedAt: new Date().toISOString(),
    });

    const controller = createWaitController(ctx);
    const waitPromise = waitForResponse(PROJECT, ctx, 10000, controller.signal);

    setTimeout(() => cancelWaitForResponse(ctx), 100);

    await assert.rejects(
      waitPromise,
      { message: "Wait cancelled - session replaced" },
    );
  });
});

// ─── Cancellation registry ───────────────────────────────────────────

describe("cancellation registry", () => {
  const ctx = "brain_CANCEL";

  afterEach(() => cancelWaitForResponse(ctx));

  it("should replace existing controller when creating a new one", () => {
    const controller1 = createWaitController(ctx);
    const controller2 = createWaitController(ctx);

    assert.strictEqual(controller1.signal.aborted, true);
    assert.strictEqual(controller2.signal.aborted, false);
  });

  it("cancelWaitForResponse should be a no-op for unknown contextId", () => {
    // Should not throw
    cancelWaitForResponse("nonexistent");
  });
});
