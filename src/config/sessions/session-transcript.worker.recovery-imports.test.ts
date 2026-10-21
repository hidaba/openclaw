import { expect, it, vi } from "vitest";
import type { SessionTranscriptWorkerRequest } from "./session-transcript-worker.types.js";

const observed = vi.hoisted(() => ({
  read: undefined as ((request: SessionTranscriptWorkerRequest) => Promise<unknown>) | undefined,
  enteredReader: 0,
}));

vi.mock("../../infra/worker-task-server.js", () => ({
  serveOwnedWorkerTasks: (read: typeof observed.read) => {
    observed.read = read;
  },
}));
vi.mock("./session-transcript-worker-scopes.js", () => ({
  withHistoryDatabase: async (_database: unknown, _operation: string, read: () => unknown) => ({
    ok: true,
    value: await read(),
  }),
  pruneClosedHistoryDatabaseScopes: () => {},
}));
vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: () => {
    // Stop at the database boundary: no query or fixture setup can warm the command graph.
    observed.enteredReader++;
    return { found: false, reason: "database-missing" };
  },
}));
vi.mock("../../state/openclaw-agent-db-validation-cache.js", () => ({
  releaseOpenClawAgentDatabaseReadValidation: () => {},
}));
vi.mock("./session-history-read-operation.worker.js", () => {
  throw new Error("Recovery must not load history operations before its first query");
});
vi.mock("./session-transcript-read-fence.js", () => {
  throw new Error("Recovery must not load transcript read fences before its first query");
});
vi.mock("./session-accessor.sqlite-entry-list.read.js", () => {
  throw new Error("Recovery must not load general entry listing before its first query");
});

// Collection owns the shared worker bootstrap; command dependencies remain cold until dispatch.
import "./session-transcript.worker.js";

it("keeps unrelated command modules cold through saved-input and exec recovery reads", async () => {
  for (const recovery of [{ pendingInputRecovery: true }, { pendingExecRecovery: { limit: 64 } }]) {
    await expect(
      observed.read!({
        kind: "session-entry-list",
        database: { agentId: "main", path: "/synthetic/agent.sqlite" },
        scope: { agentId: "main", ...recovery },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "session-entry-list", entries: [] },
    });
  }
  expect(observed.enteredReader).toBe(2);
});
