import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

// Install the shared module mocks before any source imports can load the runtime.
const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();

import { getRuntimeConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  beginGatewayRestartSignalAdmission,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionEffect,
  runSessionMutation,
  startSessionControllerInterruption,
} from "../sessions/session-controller.lifecycle.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createGatewayStartupTrace } from "./server-startup-trace.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { startPlacementRuntime } from "./server-worker-placement-startup.test-support.js";
import {
  createEnvironments,
  createIdleDiskSpace,
  createRuntimeFactory,
  placementAsyncDefaults,
  placementStoreDefaults,
  setDispatchMock,
  startRuntime,
} from "./server-worker-placement.test-support.js";
import * as workspaceRetention from "./worker-environments/node-workspace-retain-coordinator.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import type { WorkerPlacementRecoveryBarrier } from "./worker-environments/placement-recovery-contract.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { sessionIdentity } from "./worker-environments/placement-suite.test-support.js";

const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);
function mockDispatch(overrides: Partial<WorkerPlacementDispatchService> = {}) {
  setDispatchMock(runtimeFactoryMocks.createDispatch, overrides);
}

function createPlacementRuntime(
  placement: { sessionId: string; environmentId?: string | null },
  environments = createEnvironments(),
  overrides: Partial<ReturnType<typeof placementStoreDefaults>> = {},
) {
  return createRuntime({
    placements: {
      ...placementStoreDefaults(() => [placement]),
      get: () => placement,
      ...overrides,
    } as never,
    environments: environments as never,
  });
}

function startupPlacement(state: "active" | "provisioning" | "local") {
  const suffix = state === "local" ? "startup" : `startup-${state}`;
  return {
    sessionId: `session-${suffix}`,
    sessionKey: `agent:main:${suffix}`,
    agentId: "main",
    state,
    generation: 1,
    environmentId: state === "local" ? null : `worker-startup-${state}`,
    activeOwnerEpoch: state === "active" ? 1 : null,
    turnClaim: null,
  };
}

type ReconcileGuard = (environmentId: string, reconcileCore: () => Promise<void>) => Promise<void>;

async function withStoredSession(
  mode: "recovery" | "authority",
  run: (root: string, storePath: string) => Promise<void>,
) {
  await withTempDir(`worker-startup-${mode}-`, async (root) => {
    const storePath = `${root}/sessions.sqlite`;
    const target = { ...moveDestinationMocks.resolveGatewaySessionTarget(), storePath };
    const entry = moveDestinationMocks.resolveCanonicalSession();
    try {
      await upsertSessionEntryCore(
        { agentId: target.agentId, sessionKey: target.canonicalKey, storePath },
        {
          ...entry,
          updatedAt: 1,
          worktree: { ...entry.worktree, branch: "fixture", repoRoot: root },
        },
      );
      if (mode === "recovery") {
        await moveDestinationMocks.resolveGatewaySessionTarget.withImplementation(
          () => target,
          () => run(root, storePath),
        );
      } else {
        const { resolveGatewaySessionStoreTargetInWorker } = await vi.importActual<
          typeof import("./session-utils-store-worker.js")
        >("./session-utils-store-worker.js");
        await moveDestinationMocks.getRuntimeConfig.withImplementation(
          () => ({ session: { store: storePath } }),
          () =>
            moveDestinationMocks.prepareGatewaySessionTarget.withImplementation(
              resolveGatewaySessionStoreTargetInWorker,
              () => run(root, storePath),
            ),
        );
      }
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(storePath, target.agentId);
    }
  });
}

beforeEach(() => {
  runtimeFactoryMocks.createDiskSpace.mockReturnValue(createIdleDiskSpace());
});

describe("worker placement startup health lifetime", () => {
  it("samples disk on schedule while reconciliation is stuck and drains both on stop", async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const releaseReconcile = createDeferredCore();
    const releaseScheduledHealth = createDeferredCore();
    const releaseScheduledCleanup = createDeferredCore();
    const retentionStopped = createDeferredCore();
    const reconcileStarted = createDeferredCore();
    const scheduledHealthStarted = createDeferredCore();
    const healthError = new Error("probe transport failed");
    const createRetention = workspaceRetention.createNodeWorkspaceRetainCoordinator;
    const retentionFactory = vi
      .spyOn(workspaceRetention, "createNodeWorkspaceRetainCoordinator")
      .mockImplementationOnce((options) => {
        const retention = createRetention(options);
        return {
          ...retention,
          async stop() {
            await retention.stop();
            retentionStopped.resolve();
          },
        };
      });
    let holdScheduledWork = false;
    const diskSpace = {
      ...createIdleDiskSpace(),
      nextSweepAtMs: () => time.clock.now() + 60_000,
      sweep: vi.fn(async () => {
        if (holdScheduledWork) {
          scheduledHealthStarted.resolve();
          await releaseScheduledHealth.promise;
        }
      }),
    };
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const reconcileActive = vi.fn(async () => {
      if (holdScheduledWork) {
        void trackAsyncWork(() => releaseScheduledCleanup.promise);
        reconcileStarted.resolve();
        await releaseReconcile.promise;
      }
    });
    runtimeFactoryMocks.createDiskSpace.mockReturnValue(diskSpace);
    mockDispatch({ reconcile, reconcileActive });
    const environments = createEnvironments();
    const warn = vi.fn();
    const runtime = createRuntime({
      scheduler,
      environments: environments as never,
      warn,
    });
    const log = createSubsystemLogger("worker-startup-test");
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const startupTrace = createGatewayStartupTrace(log);
    let sidecar: Awaited<ReturnType<typeof runtime.startRuntime>> | undefined;
    let scheduledWake: void | Promise<void> = undefined;

    try {
      sidecar = await startRuntime(runtime, { startupTrace });

      expect(sidecar).not.toBeNull();
      const completedPhases = info.mock.calls.flatMap(([line]) => {
        const match = /sidecars\.worker-environments\.([\w-]+) [\d.]+ms/.exec(line);
        return match ? [match[1]] : [];
      });
      expect(completedPhases).toEqual(["github-ready", "workspaces", "active", "publications"]);
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(diskSpace.sweep).toHaveBeenCalledOnce();
      // Settle the background startup sweep before advancing its next deadline.
      await setImmediate();
      await time.advanceBy(60_000);
      reconcileActive.mockClear();
      diskSpace.sweep.mockClear();
      holdScheduledWork = true;
      scheduledWake = time.advanceBy(180_000);
      await Promise.all([reconcileStarted.promise, scheduledHealthStarted.promise]);
      expect(reconcileActive).toHaveBeenCalledOnce();
      expect(diskSpace.sweep).toHaveBeenCalledOnce();

      let stopSettled = false;
      const stopping = sidecar!.stop().then(() => {
        stopSettled = true;
      });
      releaseScheduledHealth.reject(healthError);
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(environments.stop).not.toHaveBeenCalled();

      releaseReconcile.resolve();
      await retentionStopped.promise;
      await Promise.resolve();
      expect(environments.stop).not.toHaveBeenCalled();
      releaseScheduledCleanup.resolve();
      await stopping;

      expect(warn).toHaveBeenCalledWith("Worker disk-space sweep failed: probe transport failed");
      expect(environments.stop).toHaveBeenCalledOnce();
    } finally {
      releaseReconcile.resolve();
      releaseScheduledHealth.resolve();
      releaseScheduledCleanup.resolve();
      await sidecar?.stop();
      await scheduledWake;
      startupTrace.close();
      info.mockRestore();
      retentionFactory.mockRestore();
    }
  });

  it.each(["provisioning", "active"] as const)(
    "waits for %s placement authority recovery before exposing readiness",
    async (state) => {
      const releaseRecovery = createDeferredCore();
      const reconcile = vi.fn(async () => await releaseRecovery.promise);
      mockDispatch({ reconcile });
      runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
      const environments = createEnvironments();
      const runtime = createPlacementRuntime(startupPlacement(state), environments);
      const starting = startRuntime(runtime);

      try {
        await vi.waitFor(() =>
          expect(reconcile).toHaveBeenCalledWith("startup", expect.any(Function)),
        );
        expect(environments.start).not.toHaveBeenCalled();

        let ready = false;
        void starting.then(() => {
          ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);

        releaseRecovery.resolve();
        const sidecar = await starting;
        expect(sidecar).not.toBeNull();
        expect(environments.start).toHaveBeenCalledOnce();
        await sidecar?.stop();
      } finally {
        releaseRecovery.resolve();
        await starting.catch(() => undefined);
      }
    },
  );

  it("defers unaccepted retirement when shutdown begins during its evidence read", async () => {
    const evidence = createDeferredCore<"absent">();
    const reconcileActive = vi.fn().mockResolvedValue(undefined);
    const retireSessionPlacementAsync = vi.fn(async () => {});
    runtimeFactoryMocks.resolveSessionEvidence.mockImplementationOnce(async () => evidence.promise);
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValueOnce(
      runtimeFactoryMocks.resolveSessionEvidence,
    );
    mockDispatch({ reconcileActive });
    const environments = createEnvironments();
    const runtime = createPlacementRuntime(startupPlacement("local"), environments, {
      retireSessionPlacementAsync,
    });
    let sidecar: { stop: () => Promise<void> } | undefined;
    const unregisterSidecar = vi.fn();
    try {
      const starting = startRuntime(runtime, {
        registerSidecar: (registered) => {
          sidecar = registered;
        },
        unregisterSidecar,
      });
      await expect(starting).resolves.toBe(sidecar);
      expect(runtimeFactoryMocks.resolveSessionEvidence).toHaveBeenCalledOnce();
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(retireSessionPlacementAsync).not.toHaveBeenCalled();

      const stopping = sidecar?.stop();
      const repeatedStop = sidecar?.stop();
      if (!stopping || !repeatedStop) {
        throw new Error("startup did not register its placement sidecar");
      }

      await Promise.resolve();
      expect(repeatedStop).toBe(stopping);
      expect(environments.beginClose).toHaveBeenCalledOnce();
      expect(environments.stop).not.toHaveBeenCalled();
      evidence.resolve("absent");
      await Promise.all([stopping, repeatedStop]);
      expect(retireSessionPlacementAsync).not.toHaveBeenCalled();
      expect(environments.stop).toHaveBeenCalledOnce();
      expect(unregisterSidecar).not.toHaveBeenCalled();
    } finally {
      evidence.resolve("absent");
      await sidecar?.stop();
    }
  });

  it("retries worker environment cleanup after a failed stop attempt", async () => {
    const stopError = new Error("tunnel cleanup failed");
    mockDispatch();
    const environments = {
      ...createEnvironments(),
      stop: vi.fn().mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined),
    };
    const runtime = createRuntime({ environments: environments as never });
    const sidecar = await startPlacementRuntime(runtime);
    const firstStop = sidecar.stop();
    expect(sidecar.stop()).toBe(firstStop);
    await expect(firstStop).rejects.toBe(stopError);
    await expect(sidecar.stop()).resolves.toBeUndefined();

    expect(environments.stop).toHaveBeenCalledTimes(2);
  });

  it("routes environment reconciliation through one exact provisioning owner", async () => {
    await withStoredSession("recovery", async () => {
      let installedGuard: ReconcileGuard | undefined;
      let placementRows: Array<{
        sessionId: string;
        state: "active" | "provisioning";
        environmentId: string;
      }> = [];
      const resumeProvisioning = vi.fn<WorkerPlacementDispatchService["resumeProvisioning"]>(
        async (placement, reconcileCore, onTransition, runAdmitted) => {
          if (!runAdmitted) {
            throw new Error("Recovery fixture requires the coordinator admission owner");
          }
          return await runAdmitted(async (signal) => {
            onTransition?.(placement);
            await reconcileCore(signal);
            return undefined;
          });
        },
      );
      const reconcile = vi.fn(async () => {
        expect(installedGuard).toBeDefined();
      });
      mockDispatch({ reconcile, resumeProvisioning });
      const environments = {
        ...createEnvironments(),
        get: vi.fn((environmentId: string) => ({ environmentId, state: "provisioning" })),
        installReconcileEnvironmentGuard: vi.fn((guard: ReconcileGuard) => {
          installedGuard = guard;
          return vi.fn();
        }),
      };
      const runtime = createRuntime({
        placements: placementStoreDefaults(() => placementRows) as never,
        environments: environments as never,
      });
      const sidecar = await startPlacementRuntime(runtime);
      const guard = installedGuard;
      if (!guard) {
        throw new Error("worker placement reconcile guard was not installed");
      }

      const provisioning = {
        sessionId: "session-recovery",
        sessionKey: "agent:main:move-source",
        agentId: "main",
        executionMode: "remote-exec" as const,
        state: "provisioning" as const,
        generation: 2,
        environmentId: "worker-guarded",
        activeOwnerEpoch: null,
      };
      try {
        placementRows = [provisioning];
        const exactCore = vi.fn(async (signal?: AbortSignal) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal?.aborted).toBe(false);
        });
        await guard(provisioning.environmentId, exactCore);
        expect(resumeProvisioning).toHaveBeenCalledOnce();
        expect(resumeProvisioning.mock.calls[0]?.[0]).toBe(provisioning);
        expect(exactCore).toHaveBeenCalledOnce();

        placementRows = [];
        const unrelatedCore = vi.fn(async () => {});
        await guard("worker-unrelated", unrelatedCore);
        expect(unrelatedCore).toHaveBeenCalledOnce();

        placementRows = [
          {
            sessionId: "session-mismatch",
            state: "active",
            environmentId: "worker-mismatch",
          },
        ];
        const mismatchedCore = vi.fn(async () => {});
        await expect(guard("worker-mismatch", mismatchedCore)).rejects.toThrow(
          "provisioning owner is active",
        );
        expect(mismatchedCore).not.toHaveBeenCalled();
        expect(resumeProvisioning).toHaveBeenCalledOnce();
      } finally {
        await sidecar.stop();
      }
    });
  });

  it("publishes shutdown before enrollment cancellation and drains guarded recovery", async () => {
    const recoveryStarted = createDeferredCore();
    const releaseRecovery = createDeferredCore();
    const environmentStopStarted = createDeferredCore();
    const events: string[] = [];
    let installedGuard: ReconcileGuard | undefined;
    let environmentStopping = false;
    const placement = {
      sessionId: "session-close-guard",
      state: "provisioning" as const,
      environmentId: "worker-close-guard",
    };
    mockDispatch({
      resumeProvisioning: vi.fn(async (_placement, reconcileCore) => {
        events.push("recovery:start");
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        await reconcileCore();
        events.push("recovery:end");
        return undefined;
      }),
    });
    const environments = {
      ...createEnvironments(),
      get: vi.fn((environmentId: string) => ({ environmentId, state: "provisioning" })),
      installReconcileEnvironmentGuard: vi.fn((guard: ReconcileGuard) => {
        installedGuard = guard;
        return async () => {
          events.push("guard:uninstall");
          await guardedRecovery;
        };
      }),
      isStopping: () => environmentStopping,
      beginClose: vi.fn(() => {
        expect(dispatchOptions.isShuttingDown?.()).toBe(true);
        expect(environmentStopping).toBe(false);
        expect(environments.stop).not.toHaveBeenCalled();
        environmentStopping = true;
        events.push("environments:begin-close");
      }),
      stop: vi.fn(async () => {
        environmentStopping = true;
        events.push("environments:stop");
        environmentStopStarted.resolve();
        await guardedRecovery;
      }),
    };
    const runtime = createPlacementRuntime(placement, environments);
    const dispatchOptions = runtimeFactoryMocks.createDispatch.mock.calls.at(-1)?.[0] as {
      isShuttingDown?: () => boolean;
    };
    resetGatewayWorkAdmission();
    try {
      expect(dispatchOptions.isShuttingDown?.()).toBe(false);
      environmentStopping = true;
      expect(dispatchOptions.isShuttingDown?.()).toBe(true);
      environmentStopping = false;
      expect(dispatchOptions.isShuttingDown?.()).toBe(false);
      const fence = beginGatewayRestartSignalAdmission();
      expect(fence).not.toBeNull();
      expect(dispatchOptions.isShuttingDown?.()).toBe(false);
      markGatewayRestartDraining();
      expect(dispatchOptions.isShuttingDown?.()).toBe(true);
      resetGatewayWorkAdmission();
      expect(dispatchOptions.isShuttingDown?.()).toBe(false);
    } finally {
      resetGatewayWorkAdmission();
    }
    const sidecar = await startPlacementRuntime(runtime);
    const guard = installedGuard;
    if (!guard) {
      throw new Error("worker placement reconcile guard was not installed");
    }
    const reconcileCore = vi.fn(async () => {
      events.push("reconcile:core");
    });
    const guardedRecovery = guard(placement.environmentId, reconcileCore);
    await recoveryStarted.promise;

    const stopping = sidecar.stop();
    await environmentStopStarted.promise;
    const postCloseCore = vi.fn(async () => {});
    await guard("worker-after-close", postCloseCore);
    expect(postCloseCore).not.toHaveBeenCalled();
    expect(environments.stop).toHaveBeenCalledOnce();

    releaseRecovery.resolve();
    await Promise.all([guardedRecovery, stopping]);
    expect(events).toEqual([
      "recovery:start",
      "environments:begin-close",
      "environments:stop",
      "reconcile:core",
      "recovery:end",
      "guard:uninstall",
    ]);
  });
});

describe("worker placement startup recovery authority", () => {
  it("holds exact session authority through async recovery work after cancellation", async () => {
    await withStoredSession("authority", async (root, storePath) => {
      mockDispatch({
        move: vi.fn(),
        reconcile: vi.fn(),
        reconcileActive: vi.fn(),
      });
      const placement = {
        state: "provisioning",
        generation: 7,
        environmentId: "worker-recovery",
      };
      createRuntime({
        placements: {
          workspaceResultInstanceId: () => "gateway-test",
          get: () => placement,
          getAsync: async () => placement,
        } as never,
        environments: {} as never,
      });
      const dispatchOptions = runtimeFactoryMocks.createDispatch.mock.calls.at(-1)?.[0] as
        | { runRecoveryBarrier: WorkerPlacementRecoveryBarrier }
        | undefined;
      if (!dispatchOptions) {
        throw new Error("worker placement recovery barrier was not captured");
      }
      const request = {
        sessionId: "session-recovery",
        sessionKey: "agent:main:move-source",
        agentId: "main",
        executionMode: "remote-exec" as const,
        environmentId: placement.environmentId,
        expectedGeneration: placement.generation,
      };
      const releaseRecovery = createDeferredCore();
      const events: string[] = [];
      const controller = new AbortController();
      const identity = {
        agentId: request.agentId,
        scope: storePath,
        identities: [request.sessionKey, request.sessionId],
      };
      const admission = await beginSessionEffect({
        ...identity,
        assertAllowed: () => {},
        onInterrupt: (reason) => controller.abort(reason),
      });
      const recovery = admission
        .run(() =>
          dispatchOptions.runRecoveryBarrier({
            ...request,
            signal: controller.signal,
            run: async (workspace) => {
              if (workspace.kind !== "local") {
                throw new Error("recovery fixture requires a local workspace");
              }
              events.push(`recovery:${workspace.path}`);
              await releaseRecovery.promise;
              events.push("recovery:done");
            },
          }),
        )
        .finally(() => admission.release());
      await vi.waitFor(() => expect(events).toEqual(["recovery:/gateway/workspace"]));
      const contender = runSessionMutation({
        agentId: request.agentId,
        scope: storePath,
        identities: [
          request.sessionKey,
          "agent:main:move-source",
          "agent:main:move-source",
          request.sessionId,
        ],
        run: async () => {
          events.push("contender");
        },
      });
      const interruption = startSessionControllerInterruption(identity);
      const admissionReleased = vi.fn();
      void interruption.released.then(admissionReleased);
      try {
        expect(controller.signal.aborted).toBe(true);
        await setImmediate();
        expect(admission.isActive()).toBe(false);
        expect(events).toEqual(["recovery:/gateway/workspace"]);
        expect(admissionReleased).not.toHaveBeenCalled();
      } finally {
        releaseRecovery.resolve();
        await Promise.all([recovery, contender, interruption.released]);
      }
      expect(admissionReleased).toHaveBeenCalledOnce();
      expect(events).toEqual(["recovery:/gateway/workspace", "recovery:done", "contender"]);

      moveDestinationMocks.resolveExecutionMode.mockReturnValueOnce("worker-turn");
      await expect(
        dispatchOptions.runRecoveryBarrier({ ...request, run: async () => {} }),
      ).rejects.toThrow("runtime changed");

      const recover = (overrides: Partial<Parameters<WorkerPlacementRecoveryBarrier>[0]> = {}) =>
        dispatchOptions.runRecoveryBarrier({ ...request, run: async () => {}, ...overrides });
      await expect(recover({ expectedGeneration: 8 })).rejects.toThrow("placement changed");

      const recoverReplacedSession = vi.fn(async () => {});
      // Keep the replacement installed through preparation and the final authority check.
      await moveDestinationMocks.resolveCanonicalSession.withImplementation(
        () => ({
          sessionId: "session-replaced",
          worktree: { id: "worktree-recovery", branch: "fixture", repoRoot: root },
        }),
        () =>
          expect(recover({ run: recoverReplacedSession })).rejects.toThrow(
            "changed before cloud worker recovery",
          ),
      );
      expect(recoverReplacedSession).not.toHaveBeenCalled();
    });
  });
});

async function releaseLocalTurn(
  placements: Parameters<typeof createGatewayWorkerPlacementRuntime>[0]["placements"],
  identity: ReturnType<typeof sessionIdentity>,
) {
  await placements.releaseTurn(
    await placements.claimTurn({
      ...identity,
      claimId: `${identity.sessionId}-claim`,
      runId: `${identity.sessionId}-run`,
      owner: { kind: "local" },
    }),
  );
}

function emitDeletion(databaseIdentity: symbol) {
  emitSessionIdentityMutation({
    kind: "delete",
    agentId: "main",
    databaseIdentity,
    previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
  });
}

function startEventRuntime(
  time: ReturnType<typeof createGatewaySchedulerClock>,
  reconcileActive: () => Promise<void>,
  warn: Parameters<typeof createGatewayWorkerPlacementRuntime>[0]["warn"],
  placements: Parameters<
    typeof createGatewayWorkerPlacementRuntime
  >[0]["placements"] = placementAsyncDefaults() as never,
) {
  runtimeFactoryMocks.createDiskSpace.mockReturnValue(createIdleDiskSpace());
  setDispatchMock(runtimeFactoryMocks.createDispatch, { reconcileActive });
  return startRuntime(
    createRuntime({
      scheduler: createTestGatewayScheduler(time.clock),
      placements,
      warn,
    }),
  );
}

it("retires changed placements after real placement and session writes without idle rescans", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const time = createGatewaySchedulerClock();
    const placements = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase(),
    });
    const identity = sessionIdentity("retirement-current");
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    await upsertSessionEntryCore(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: Date.now() },
    );
    await releaseLocalTurn(placements, identity);
    const evidence = await vi.importActual<
      typeof import("./server-worker-placement-session-evidence.js")
    >("./server-worker-placement-session-evidence.js");
    runtimeFactoryMocks.createSessionEvidenceResolver.mockImplementation(
      evidence.createWorkerPlacementSessionEvidenceResolver,
    );
    const list = vi.spyOn(placements, "listAsync");
    let reconciled = createDeferredCore();
    const warn = vi.fn();
    const sidecar = await startEventRuntime(
      time,
      vi.fn(async () => reconciled.resolve()),
      warn,
      placements,
    );
    try {
      await time.advanceBy(60_000);
      await time.advanceBy(60_000);
      expect(list).toHaveBeenCalledOnce();
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenCalledOnce();
      expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);

      sessionChanges.emit({ all: true, scope: "worker-placements" });
      sessionChanges.emit({ all: true, scope: "config-presentation" });
      sessionChanges.emit({
        sessionKey: identity.sessionKey,
        scope: "transcript",
        factsInvalidated: true,
      });
      await time.advanceBy(60_000);
      expect(list).toHaveBeenCalledOnce();
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenCalledOnce();

      const invalidations: SessionRowChange[] = [
        { all: true, scope: "config" },
        { ...identity, factsInvalidated: true },
      ];
      for (const [index, change] of invalidations.entries()) {
        sessionChanges.emit(change);
        await time.advanceBy(60_000);
        expect(list).toHaveBeenCalledTimes(2 + index);
      }

      const orphan = sessionIdentity("retirement-orphan");
      await releaseLocalTurn(placements, orphan);
      await time.advanceBy(60_000);
      expect(await placements.getAsync(orphan.sessionId)).toBeUndefined();
      expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith(
        [expect.objectContaining(orphan)],
        expect.any(AbortSignal),
      );
      expect(list).toHaveBeenCalledTimes(3);

      reconciled = createDeferredCore();
      await deleteSessionEntryLifecycle({
        agentId: identity.agentId,
        storePath,
        archiveTranscript: false,
        target: { canonicalKey: identity.sessionKey, storeKeys: [identity.sessionKey] },
      });
      await reconciled.promise;
      expect(await placements.getAsync(identity.sessionId)).toBeUndefined();
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith(
        [expect.objectContaining(identity)],
        expect.any(AbortSignal),
      );
      expect(list).toHaveBeenCalledTimes(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await sidecar?.stop();
    }
  }));

it("finishes background reconciliation after the notifying session request closes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const time = createGatewaySchedulerClock();
    const placements = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase(),
    });
    let completed = createDeferredCore<boolean>();
    const reconcileActive = vi.fn(async () => {
      try {
        await placements.readRecoveryCandidates();
        completed.resolve(true);
      } catch (error) {
        completed.resolve(false);
        throw error;
      }
    });
    const warn = vi.fn();
    const sidecar = await startEventRuntime(time, reconcileActive, warn);
    try {
      await time.advanceBy(60_000);
      reconcileActive.mockClear();
      completed = createDeferredCore<boolean>();
      const request = new AsyncWorkScope();
      request.run(() => emitDeletion(Symbol("session-database")));
      await request.drain();
      expect(await completed.promise).toBe(true);
      expect(reconcileActive).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await sidecar?.stop();
    }
  }));

it("reports a failed reconciliation queued by a session change without leaking rejection", async () => {
  const time = createGatewaySchedulerClock();
  const releaseReconcile = createDeferredCore();
  const reconcileStarted = createDeferredCore();
  const failureReported = createDeferredCore();
  const reconcileActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const warn = vi.fn(() => failureReported.resolve());
  const sidecar = await startEventRuntime(time, reconcileActive, warn);
  let scheduledWake: void | Promise<void> = undefined;
  try {
    await time.advanceBy(60_000);
    expect(warn).not.toHaveBeenCalled();
    reconcileActive.mockClear();
    reconcileActive
      .mockImplementationOnce(() => {
        reconcileStarted.resolve();
        return releaseReconcile.promise;
      })
      .mockRejectedValue(new Error("Worker environment inventory has closed"));
    scheduledWake = time.advanceBy(60_000);
    await reconcileStarted.promise;
    expect(reconcileActive).toHaveBeenCalledOnce();
    emitDeletion(Symbol("worker-placement-database"));
    releaseReconcile.resolve();
    await failureReported.promise;
    expect(reconcileActive).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "Worker placement reconcile sweep failed: Worker environment inventory has closed",
    );
  } finally {
    releaseReconcile.resolve();
    await sidecar?.stop();
    await scheduledWake;
  }
});
