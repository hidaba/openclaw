import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

// Install the shared module mocks before any source imports can load the runtime.
const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();

vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: vi.fn(async () => {}),
}));

vi.mock("../agents/model-thinking-default.js", () => ({
  resolveThinkingSelection: () => {
    throw new Error("Queue settlement must not refresh model selection");
  },
}));
vi.mock("../auto-reply/thinking.js", async () => {
  const { normalizeThinkLevel } = await import("../auto-reply/thinking.shared.js");
  return { normalizeThinkLevel };
});

vi.mock("../auto-reply/reply/queue/drain.js", () => {
  const unexpectedDrain = () => {
    throw new Error("worker barrier queue fixtures must remain pending");
  };
  return {
    clearFollowupDrainCallback: () => {},
    rememberFollowupDrainCallback: unexpectedDrain,
    kickFollowupDrainIfIdle: unexpectedDrain,
    prepareStaleFollowupDrainRetirement: unexpectedDrain,
    dropAbortedFollowups: unexpectedDrain,
    scheduleFollowupDrain: unexpectedDrain,
  };
});

import { getRuntimeConfig } from "../config/config.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayWorkerPlacementLocalDispatchBarrier } from "./server-worker-placement-local-dispatch.js";
import {
  createGatewayWorkerPlacementMoveBarrier,
  runWorkerPlacementHandoff,
} from "./server-worker-placement-move-barrier.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetInWorker,
} from "./session-utils.js";
import type { WorkerPlacementMoveBarrier } from "./worker-environments/placement-move-service.js";
import { localPlacement } from "./worker-environments/placement-suite.test-support.js";

const session = {
  sessionId: "session-move-source",
  sessionKey: "agent:main:move-source",
  agentId: "main",
};
const researchSession = { sessionKey: "global", sessionId: "research-global", agentId: "research" };
const sessionRuntime = {
  managedWorktrees: { findLiveByOwner: async () => undefined },
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetInWorker,
};
const loadSessionRuntime = async () => sessionRuntime;
const beginMove = async () => createMoveBarrierBeginFixture(session.sessionId, session.sessionKey);
const sourceInspection = ["authorize", "inspect-intent", "validate-source"];
const persistedClaim = [...sourceInspection, "persist", "authorize", "validate-claim"];

type MoveTarget = Awaited<ReturnType<typeof resolveGatewaySessionStoreTargetInWorker>>;
async function withMoveSession(run: (target: MoveTarget) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg: {},
      key: session.sessionKey,
      agentId: session.agentId,
    });
    await run(target);
  });
}

function enqueueFixtureFollowup(
  identity: { agentId: string; sessionId: string; sessionKey: string },
  storePath: string,
  prompt: string,
) {
  const { agentId, sessionId, sessionKey } = identity;
  const followup = createQueueTestRun({ prompt });
  followup.run = { ...followup.run, agentId, sessionId, config: { session: { store: storePath } } };
  enqueueFollowupRun(
    sessionKey,
    followup,
    { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
    "none",
    undefined,
    false,
  );
  return getExistingFollowupQueue(sessionKey, followup.controllerInput!.target);
}

function createMoveBarrierBeginFixture(sessionId: string, sessionKey: string, agentId = "main") {
  const source = { generation: 4, environmentId: "environment-source", ownerEpoch: 2 };
  return {
    intent: {
      operationId: "move:v1:test",
      sessionId,
      source,
      target: { kind: "gateway" },
      abandonSource: true,
      lastError: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    placement: {
      ...localPlacement(sessionId),
      sessionKey,
      agentId,
      state: "draining",
      generation: 5,
      environmentId: source.environmentId,
      activeOwnerEpoch: source.ownerEpoch,
      workspaceBaseManifestRef: "manifest-source",
      remoteWorkspaceDir: "/worker/session-source",
      workerBundleHash: "c".repeat(64),
      updatedAtMs: 2,
      stateChangedAtMs: 2,
    },
    joined: false,
  } satisfies Awaited<ReturnType<Parameters<WorkerPlacementMoveBarrier>[0]["begin"]>>;
}

describe("worker placement move destination", () => {
  it.each(
    (["dispatch", "required", "reconcile", "abandon"] as const).flatMap((action) =>
      (["current", "revoked after commit"] as const).map((authority) => ({ action, authority })),
    ),
  )(
    "$action preserves another agent's controller work under the global key ($authority authority)",
    async ({ action, authority }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { sessionKey, sessionId, agentId } = researchSession;
        let committed = false;
        const assertAuthority = () => {
          if (committed && authority === "revoked after commit") {
            throw new Error("placement authority revoked after commit");
          }
        };
        const target = {
          agentId,
          canonicalKey: sessionKey,
          store: {},
          storeKeys: [sessionKey],
          storePath: "/tmp/openclaw-worker-placement-research.sqlite",
        };
        moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValueOnce(target);
        moveDestinationMocks.resolveSessionTarget.mockResolvedValueOnce({
          assertCurrent: assertAuthority,
          assertBindingCurrent: assertAuthority,
          config: {},
          entry: { sessionId, updatedAt: 1 },
          target,
          worktree: { id: "research-worktree", path: "/gateway/research" },
          workspace: { kind: "local", path: "/gateway/research" },
          [Symbol.dispose]: () => {},
        });
        const effects: string[] = [];
        const mainStorePath = "/tmp/openclaw-worker-placement-main.sqlite";
        const mainAdmission = await beginSessionEffect({
          scope: mainStorePath,
          identities: [sessionKey, "main-global"],
          agentId: "main",
          assertAllowed: () => {},
          onInterrupt: () => {
            effects.push("main interrupt");
          },
        });
        const mainQueue = enqueueFixtureFollowup(
          { sessionKey, agentId: "main", sessionId: "main-global" },
          mainStorePath,
          "keep main follow-up",
        );
        const researchQueue = enqueueFixtureFollowup(
          researchSession,
          target.storePath,
          "keep required first input",
        );
        let releaseAdmission = () => {};
        const admission =
          action === "required"
            ? undefined
            : await beginSessionEffect({
                scope: target.storePath,
                identities: [sessionKey, sessionId],
                agentId,
                assertAllowed: () => {},
                onInterrupt: () => {
                  effects.push("interrupt");
                  releaseAdmission();
                },
              });
        releaseAdmission = admission?.release ?? (() => {});
        const commit = () => {
          committed = true;
          effects.push("commit");
          return createMoveBarrierBeginFixture(sessionId, sessionKey, agentId);
        };
        const options = {
          placements: {
            get: () => undefined,
            getAsync: async () => undefined,
            waitForTurnClaimRelease: async () => {
              effects.push("claims released");
            },
          },
          revokeSessionAuthority: () => {
            effects.push("revoke");
          },
        };
        try {
          if (action === "required") {
            await runWorkerPlacementHandoff(
              options,
              { ...researchSession, action: "dispatch", requiredProfile: "dedicated" },
              sessionRuntime,
              async () => commit().placement,
            );
          } else if (action === "dispatch") {
            await expect(
              createGatewayWorkerPlacementLocalDispatchBarrier(options)({
                ...researchSession,
                executionMode: "remote-exec",
                authorize: assertAuthority,
                startDispatch: async () => commit().placement,
              }),
            ).rejects.toThrow("is busy with active work");
          } else {
            await createGatewayWorkerPlacementMoveBarrier({
              ...options,
              loadSessionRuntime,
            })({
              ...researchSession,
              sourceDisposition: action,
              authorize: assertAuthority,
              begin: async () => commit(),
            });
          }
          expect(effects).toEqual(
            action === "required"
              ? ["commit"]
              : action === "dispatch"
                ? []
                : [
                    "commit",
                    "revoke",
                    "interrupt",
                    ...(action === "abandon" ? [] : ["claims released"]),
                  ],
          );
          expect(mainAdmission.isActive()).toBe(true);
          expect(admission?.isActive() ?? false).toBe(action === "dispatch");
          expect(mainQueue?.items.map((item) => item.prompt)).toEqual(["keep main follow-up"]);
          expect(researchQueue?.items.map((item) => item.prompt)).toEqual(
            action === "required" || action === "dispatch" ? ["keep required first input"] : [],
          );
        } finally {
          if (mainQueue) {
            clearFollowupQueue(sessionKey, mainQueue);
          }
          if (researchQueue) {
            clearFollowupQueue(sessionKey, researchQueue);
          }
          admission?.release();
          mainAdmission.release();
        }
      });
    },
  );

  it("joins an accepted keyed store write before completing a reconciled move", async () => {
    await withMoveSession(async (target) => {
      const releaseWriter = createDeferred();
      const claimsReleased = createDeferred();
      const order: string[] = [];
      const writer = runExclusiveSessionStoreWrite(
        target.storePath,
        async () => {
          await releaseWriter.promise;
          order.push("write settled");
        },
        { identities: [session.sessionKey] },
      );
      const barrier = createGatewayWorkerPlacementMoveBarrier({
        placements: {
          waitForTurnClaimRelease: async () => {
            claimsReleased.resolve();
          },
        },
        loadSessionRuntime,
        revokeSessionAuthority: () => {},
      });
      vi.useFakeTimers();
      const move = barrier({
        ...session,
        sourceDisposition: "reconcile",
        begin: beginMove,
      }).then(() => order.push("move settled"));
      try {
        await claimsReleased.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual([]);
        releaseWriter.resolve();
        await Promise.all([writer, move]);
        expect(order).toEqual(["write settled", "move settled"]);
      } finally {
        releaseWriter.resolve();
        await Promise.allSettled([writer, move]);
        vi.useRealTimers();
      }
    });
  });

  it.each([
    ["persists the claimed partial", "worker-run", "success"],
    ["rejects authority revoked during persistence", "worker-run", "revoked-authority"],
    ["does not persist an unclaimed turn", undefined, "success"],
  ] as const)(
    "abandonment %s before interrupting its owner",
    async (_name, claimRunId, outcome) => {
      await withMoveSession(async (target) => {
        const { sessionId, sessionKey } = session;
        const identities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
        const observed: string[] = [];
        const admission = await beginSessionEffect({
          agentId: session.agentId,
          scope: target.storePath,
          identities,
          assertAllowed: () => undefined,
          onInterrupt: () => {
            observed.push("interrupt");
          },
        });
        const persistAbandonedPartial = vi.fn(async () => {
          observed.push("persist");
        });
        const revokeSessionAuthority = vi.fn(() => observed.push("revoke"));
        const barrier = createGatewayWorkerPlacementMoveBarrier({
          placements: { waitForTurnClaimRelease: vi.fn() },
          loadSessionRuntime,
          revokeSessionAuthority,
          persistAbandonedPartial,
        });
        const begin = vi.fn(async (prepareNew?: (runId: string) => Promise<void>) => {
          observed.push("inspect-intent");
          observed.push("validate-source");
          if (claimRunId) {
            await prepareNew?.(claimRunId);
            observed.push("validate-claim");
          }
          observed.push("begin");
          return createMoveBarrierBeginFixture(sessionId, sessionKey);
        });
        const operation = barrier({
          ...session,
          sourceDisposition: "abandon",
          authorize: () => {
            observed.push("authorize");
            if (outcome === "revoked-authority" && observed.includes("persist")) {
              throw new Error("session access revoked");
            }
          },
          begin,
        });
        try {
          if (outcome === "revoked-authority") {
            await expect(operation).rejects.toThrow("session access revoked");
            expect(revokeSessionAuthority).not.toHaveBeenCalled();
            expect(observed).toEqual([...sourceInspection, "persist", "authorize"]);
          } else {
            await expect(operation).resolves.toMatchObject({ placement: { state: "draining" } });
            expect(observed).toEqual([
              ...(claimRunId ? persistedClaim : sourceInspection),
              "begin",
              "revoke",
              "interrupt",
            ]);
          }
          expect(begin).toHaveBeenCalledOnce();
          if (claimRunId) {
            expect(persistAbandonedPartial).toHaveBeenCalledWith({
              ...session,
              runId: claimRunId,
            });
          } else {
            expect(persistAbandonedPartial).not.toHaveBeenCalled();
          }
        } finally {
          admission.release();
          await operation.catch(() => undefined);
        }
      });
    },
  );

  it.each([
    { sourceDisposition: "abandon" as const, settlesImmediately: true },
    { sourceDisposition: "reconcile" as const, settlesImmediately: false },
  ])(
    "$sourceDisposition move interruption preserves its settlement contract",
    async ({ sourceDisposition, settlesImmediately }) => {
      await withMoveSession(async (target) => {
        vi.useFakeTimers();
        const identities = [
          session.sessionKey,
          target.canonicalKey,
          ...target.storeKeys,
          session.sessionId,
        ];
        const onInterrupt = vi.fn();
        const admission = await beginSessionEffect({
          scope: target.storePath,
          identities,
          agentId: "main",
          assertAllowed: () => undefined,
          onInterrupt,
        });
        const waitForTurnClaimRelease = vi.fn().mockResolvedValue(undefined);
        runtimeFactoryMocks.createDiskSpace.mockReturnValue({
          read: vi.fn(),
          version: vi.fn(() => 0),
          sweep: vi.fn().mockResolvedValue(undefined),
        });
        runtimeFactoryMocks.createDispatch.mockReturnValue({
          dispatch: vi.fn(),
          forceDestroyEnvironment: vi.fn(),
          move: vi.fn(),
          reclaim: vi.fn(),
          reconcile: vi.fn(),
          reconcileActive: vi.fn(),
        });
        const { createGatewayWorkerPlacementRuntime } =
          await import("./server-worker-placement-startup.js");
        createGatewayWorkerPlacementRuntime({
          initialPlacements: [],
          scheduler: createTestGatewayScheduler(),
          getCommittedRuntimeConfig: getRuntimeConfig,
          cancelSessionWork: vi.fn(async () => {}),
          placements: {
            workspaceResultInstanceId: () => "gateway-test",
            get: () => undefined,
            list: () => [],
            waitForTurnClaimRelease,
            retireSessionPlacement: vi.fn(),
            pruneOrphanedWorkspaceReconciliations: async () => [],
            listWorkspaceReconciliationOwners: async () => [],
            listPendingWorkspaceResultsAsync: async () => [],
          } as never,
          environments: {} as never,
          gatewayNamespace: "gateway-test",
          revokeSessionAuthority: vi.fn(),
          warn: vi.fn(),
        });
        const dispatchOptions = runtimeFactoryMocks.createDispatch.mock.calls.at(-1)?.[0] as
          | { runMoveBarrier: WorkerPlacementMoveBarrier }
          | undefined;
        if (!dispatchOptions) {
          throw new Error("worker placement move barrier was not captured");
        }
        const begin = vi.fn(beginMove);
        const operation = dispatchOptions.runMoveBarrier({
          ...session,
          sourceDisposition,
          begin,
        });
        let settled = false;
        const markSettled = () => {
          settled = true;
        };
        void operation.then(markSettled, markSettled);
        try {
          await vi.waitFor(() => expect(begin).toHaveBeenCalledOnce());
          expect(onInterrupt).toHaveBeenCalledOnce();
          expect(settled).toBe(settlesImmediately);
          expect(waitForTurnClaimRelease).not.toHaveBeenCalled();
          if (!settlesImmediately) {
            await vi.advanceTimersByTimeAsync(15_000);
            await expect(operation).rejects.toThrow("placement move interrupted");
          } else {
            await expect(operation).resolves.toMatchObject({ placement: { state: "draining" } });
          }
        } finally {
          admission.release();
          await operation.catch(() => undefined);
          vi.useRealTimers();
        }
      });
    },
  );
});
