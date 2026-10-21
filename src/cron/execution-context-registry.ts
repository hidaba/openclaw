/**
 * Per-run lookup for the scheduled execution context. The admission owner binds
 * a context to its operational run instance; tool construction reads the
 * targets it needs. Leaf module: agent tools import it without cron's graph.
 */
import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import type { ScheduledMemoryParent } from "../plugins/memory-audience.js";
import type { ScheduledExecutionFacts } from "./execution-context.js";

const factsByRun = new WeakMap<OperationalRunInstanceRef, ScheduledExecutionFacts>();

/** Admission-only: binds an occurrence's facts to its admitted run. */
export function bindScheduledExecutionFacts(
  run: OperationalRunInstanceRef,
  facts: ScheduledExecutionFacts,
): () => void {
  factsByRun.set(run, facts);
  return () => {
    if (factsByRun.get(run) === facts) {
      factsByRun.delete(run);
    }
  };
}

/** Session keys a scheduled run's board, widget and media tools act on. */
export type ScheduledToolTargets = Readonly<{
  boardSessionKey: string;
  mediaSessionKey: string;
}>;

/** Targets for a run admitted with an execution context, or undefined for other runs. */
export function readScheduledToolTargets(
  run: OperationalRunInstanceRef | undefined,
): ScheduledToolTargets | undefined {
  const facts = run ? factsByRun.get(run) : undefined;
  return facts
    ? {
        boardSessionKey: facts.resources.boardSessionKey,
        mediaSessionKey: facts.resources.mediaSessionKey,
      }
    : undefined;
}

/** The parent whose memory audience a child run inherits, or undefined to resolve from the run row. */
export function readScheduledMemoryParent(
  run: OperationalRunInstanceRef | undefined,
): ScheduledMemoryParent | undefined {
  const memory = run ? factsByRun.get(run)?.resources.memory : undefined;
  if (memory?.source !== "parent") {
    return undefined;
  }
  const { parent, owner } = memory;
  return {
    sessionKey: parent.sessionKey,
    sessionId: parent.sessionId,
    ...(parent.lifecycleRevision ? { lifecycleRevision: parent.lifecycleRevision } : {}),
    senderIsOwner: owner,
  };
}
