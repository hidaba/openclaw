import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronStoredJob } from "./types.js";

const readSessionEntryInWorker = vi.fn<(params: { sessionKey: string }) => Promise<unknown>>();
const generationRelease = vi.fn();
const generationAssert = vi.fn();
const prepareSessionGenerationFacts = vi.fn(async (_input: unknown) => ({
  assertCurrent: generationAssert,
  release: generationRelease,
}));

vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryInWorker: (params: { sessionKey: string }) => readSessionEntryInWorker(params),
}));
vi.mock("../config/sessions/session-delivery-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-delivery-generation.js")>()),
  prepareSessionGenerationFacts: (input: unknown) => prepareSessionGenerationFacts(input),
}));

const { mintCronPromptExecutionContext, resolveScheduledParentPreparation } =
  await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");
const { readScheduledMemoryParent, readScheduledToolTargets } =
  await import("./execution-context-registry.js");
const { finalizeCliMcpGrant } = await import("../agents/cli-runner/mcp-grant-context.js");

const PARENT_KEY = "agent:main:dashboard:parent";

function job(overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "work", toolsAllow: ["*"] },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

function mint(stored: CronStoredJob) {
  return mintCronPromptExecutionContext(
    {
      cfgWithAgentDefaults: {},
      job: stored,
      agentId: "main",
      runSessionKey: "agent:main:cron:job-1:run:s1",
      cronSession: { storePath: "/tmp/store.json" },
      agentPayload: { toolsAllow: ["*"] },
    },
    { runId: "run-1", trigger: "cron" },
  );
}

beforeEach(() => {
  readSessionEntryInWorker.mockReset();
  prepareSessionGenerationFacts.mockClear();
  generationRelease.mockReset();
  generationAssert.mockReset();
});

describe("mintCronPromptExecutionContext", () => {
  it("binds the context to the admitted run and releases it on close", async () => {
    const minted = await mint(job({ scheduledToolPolicy: { version: 1, mode: "trusted" } }));
    expect(minted.result.status).toBe("ready");
    const admission = prepareCronRunAdmission({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:cron:job-1:run:s1",
      jobId: "job-1",
      deliveryAttemptFence: null,
      scheduledExecution: minted,
    });
    const operatorRun = await admission.preparedRunAdmission.admit("embedded");
    // An operator job keeps resolving memory from its own run row.
    expect(readScheduledMemoryParent(operatorRun.operationalRunInstance)).toBeUndefined();
    const context = admission.readScheduledExecution();
    expect(context).toMatchObject({
      jobId: "job-1",
      principal: { kind: "operator", basis: "trusted-policy" },
    });
    expect(() => context?.assertCurrent()).not.toThrow();
    admission.close();
    expect(admission.readScheduledExecution()).toBeUndefined();
  });

  it("reaches the CLI loopback through the run's grant", async () => {
    const minted = await mint(job({ scheduledToolPolicy: { version: 1, mode: "trusted" } }));
    const admission = prepareCronRunAdmission({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:cron:job-1:run:s1",
      jobId: "job-1",
      deliveryAttemptFence: null,
      scheduledExecution: minted,
    });
    const admitted = await admission.preparedRunAdmission.admit("gateway");
    const grant = finalizeCliMcpGrant({ runId: "run-1" } as never, undefined, false, {
      admittedRunContext: admitted,
    });
    // The loopback server resolves tools with this same admitted run (mcp-http.runtime.ts),
    // which the minted context is bound to.
    expect(grant?.admittedRunContext).toBe(admitted);
    expect(admission.readScheduledExecution()?.jobId).toBe("job-1");
    admission.close();
  });

  it("holds the parent generation for a linked job and releases it", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const minted = await mint(
      job({
        owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: PARENT_KEY,
          ownerAccountId: "default",
        },
        sourceConversation: {
          sessionKey: PARENT_KEY,
          sessionId: "parent-session",
          lifecycleRevision: "rev-1",
        },
      }),
    );
    expect(minted.result).toMatchObject({ status: "ready", facts: { placement: "child" } });
    expect(prepareSessionGenerationFacts).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: PARENT_KEY, sessionId: "parent-session" }),
    );
    minted.release();
    expect(generationRelease).toHaveBeenCalledOnce();
  });

  it("exposes a child's board, media and memory parent for the run", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const minted = await mint(
      job({
        owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: PARENT_KEY,
          ownerAccountId: "default",
        },
        sourceConversation: {
          sessionKey: PARENT_KEY,
          sessionId: "parent-session",
          lifecycleRevision: "rev-1",
        },
      }),
    );
    const admission = prepareCronRunAdmission({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:cron:job-1:run:s1",
      jobId: "job-1",
      deliveryAttemptFence: null,
      scheduledExecution: minted,
    });
    const admitted = await admission.preparedRunAdmission.admit("embedded");
    expect(readScheduledToolTargets(admitted.operationalRunInstance)).toEqual({
      boardSessionKey: PARENT_KEY,
      mediaSessionKey: PARENT_KEY,
    });
    // No requester check ran for this occurrence, so the parent's audience is not owner-private.
    expect(readScheduledMemoryParent(admitted.operationalRunInstance)).toEqual({
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      senderIsOwner: false,
    });
    admission.close();
    expect(readScheduledToolTargets(admitted.operationalRunInstance)).toBeUndefined();
    expect(readScheduledMemoryParent(admitted.operationalRunInstance)).toBeUndefined();
  });

  it("reports a removed parent as a pause without throwing", async () => {
    readSessionEntryInWorker.mockResolvedValue(undefined);
    const minted = await mint(
      job({ sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } }),
    );
    expect(minted.result).toEqual({
      status: "pause",
      reason: "removed",
      parentSessionKey: PARENT_KEY,
    });
    expect(prepareSessionGenerationFacts).not.toHaveBeenCalled();
  });

  it("turns a failed parent read into a fail result", async () => {
    readSessionEntryInWorker.mockRejectedValue(new Error("worker unavailable"));
    const minted = await mint(
      job({ sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } }),
    );
    expect(minted.result).toEqual({ status: "fail", error: "worker unavailable" });
    expect(() => minted.release()).not.toThrow();
  });
});

describe("resolveScheduledParentPreparation", () => {
  const linked = job({
    name: "Nightly ingest",
    sourceConversation: {
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    },
  });
  const check = (stored: CronStoredJob) =>
    resolveScheduledParentPreparation({
      cfg: {},
      job: stored,
      agentId: "main",
      storePath: "/tmp/store.json",
    });

  it("does not read anything for jobs without an exact parent link", async () => {
    await expect(check(job())).resolves.toBeUndefined();
    expect(readSessionEntryInWorker).not.toHaveBeenCalled();
  });

  it.each([
    ["removed", undefined],
    ["archived", { sessionId: "parent-session", lifecycleRevision: "rev-1", archivedAt: 1 }],
  ] as const)("pauses when the parent is %s", async (reason, entry) => {
    readSessionEntryInWorker.mockResolvedValue(entry);
    await expect(check(linked)).resolves.toMatchObject({
      kind: "pause",
      result: { status: "skipped", parentUnavailable: { reason, parentSessionKey: PARENT_KEY } },
    });
  });

  it("keeps running when the parent was reset", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "new-session",
      lifecycleRevision: "rev-2",
    });
    await expect(check(linked)).resolves.toBeUndefined();
  });

  it("pauses when the parent's bound worktree is gone, naming the path", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      spawnedCwd: "/tmp/openclaw-missing-worktree-for-test",
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/tmp/repo" },
    });
    const preparation = await check(linked);
    expect(preparation).toMatchObject({
      kind: "pause",
      result: {
        parentUnavailable: {
          reason: "worktree-missing",
          worktreePath: "/tmp/openclaw-missing-worktree-for-test",
        },
      },
    });
  });

  it("hands a child run its current parent's row and sandbox requirement", async () => {
    const parentEntry = {
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      sandbox: "required" as const,
    };
    readSessionEntryInWorker.mockResolvedValue(parentEntry);
    await expect(check(linked)).resolves.toEqual({
      kind: "child",
      binding: { sessionKey: PARENT_KEY, entry: parentEntry },
      sandbox: "required",
    });
  });

  it("leaves an in-session job's own binding to the session it runs in", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    await expect(
      check({ ...linked, sessionTarget: `session:${PARENT_KEY}` }),
    ).resolves.toBeUndefined();
  });

  it("never pauses on a failed read", async () => {
    readSessionEntryInWorker.mockRejectedValue(new Error("worker unavailable"));
    await expect(check(linked)).resolves.toBeUndefined();
  });

  it("names the parent and the repair in the notice", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      archivedAt: 1,
    });
    const preparation = await check(linked);
    const text = preparation?.kind === "pause" ? preparation.result.error : "";
    expect(text).toContain(`\`${PARENT_KEY}\``);
    expect(text).toContain("it was archived");
    expect(text).toContain("openclaw automations enable job-1");
  });
});
