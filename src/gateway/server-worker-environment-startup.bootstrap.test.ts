import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import * as metadataState from "../plugins/current-plugin-metadata-state.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import * as version from "../version.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import {
  createWorkerStartupRuntime,
  provisionStartupWorker,
} from "./server-worker-environment-startup.runtime.test-support.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";
import * as artifactModule from "./worker-environments/node-bootstrap-artifact.js";
import * as enrollmentModule from "./worker-environments/node-enrollment.js";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    cleanup();
  }),
);

function makeRegistry(
  metadata: ReturnType<typeof createPluginMetadataSnapshotFixture>,
  id: string,
  source = `/source/extensions/${id}/index.js`,
  command = `${id}.exec`,
) {
  const registry = createEmptyPluginRegistry();
  registry.plugins = metadata.plugins.map((record) =>
    createPluginRecord({ ...record, enabled: true, configSchema: true }),
  );
  registry.agentHarnesses.push({
    pluginId: id,
    source,
    harness: {
      id,
      label: id,
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: { requiredNodeCommands: [command], consumesWorkerSlot: false },
      },
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
    },
  });
  registry.nodeHostCommands.push({
    pluginId: id,
    source,
    command: { command, handle: async () => "{}" },
  });
  return registry;
}

async function provision(
  startup: Awaited<ReturnType<typeof loadGatewayWorkerEnvironmentStartupState>>,
  environmentId: string,
) {
  return provisionStartupWorker(
    startup,
    {
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { executionMode: "remote-exec", settings: {} },
    },
    { nodeDeviceId: `${environmentId}-node` },
  );
}

it("refreshes registry and metadata generations, retires old artifacts, and drains them on shutdown", async () => {
  const stateDir = await fs.realpath(tempDirs.make("openclaw-bootstrap-generation-"));
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: ["runtime-a", "runtime-b"].map((id) => ({
      id,
      rootDir: `/source/extensions/${id}`,
      packageName: `@example/${id}`,
      packageVersion: "1.2.3",
    })),
  });
  let registry = makeRegistry(metadata, "runtime-a");
  const metadataSnapshot = vi
    .spyOn(metadataState, "getGatewayPluginMetadataSnapshot")
    .mockReturnValue(metadata);
  vi.spyOn(version, "resolveRuntimeServiceBuildId").mockReturnValue("gateway-source-build");
  const enrollmentFactory = vi.spyOn(enrollmentModule, "createWorkerNodeEnrollmentManager");
  const makeProducer = (number: number, enabledPluginIds: string[]) => {
    const closure = createDeferredCore();
    const closing = createDeferredCore();
    const artifact = {
      tarballPath: path.join(stateDir, `runtime-${number}.tgz`),
      tarballSha256: String(number).repeat(64),
      tarballBytes: 1,
      openclawVersion: "2026.8.1",
      buildId: "gateway-source-build",
      enabledPluginIds,
    };
    return {
      artifact,
      prepare: vi.fn(async (_signal?: AbortSignal) => {
        await fs.writeFile(artifact.tarballPath, "x");
        return artifact;
      }),
      close: vi.fn(async () => {
        closing.resolve();
        await closure.promise;
        await fs.rm(artifact.tarballPath, { force: true });
      }),
      closing: closing.promise,
      release: () => closure.resolve(),
    };
  };
  const producers: ReturnType<typeof makeProducer>[] = [];
  const releaseAll = () => producers.forEach((producer) => producer.release());
  vi.spyOn(artifactModule, "createNodeBootstrapArtifactProvider").mockImplementation(
    ({ plugins }) => {
      const producer = makeProducer(
        producers.length + 1,
        plugins.map(({ id }) => id),
      );
      producers.push(producer);
      return producer;
    },
  );

  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    setRuntimeConfigSnapshot({ gateway: { publicOrigin: "https://gateway.example.test" } });
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    const runtime = await createWorkerStartupRuntime(startup, () => registry);
    const enrollmentResult = enrollmentFactory.mock.results.at(-1);
    const service = runtime.workerEnvironmentService;
    assert(
      enrollmentResult?.type === "return" && service,
      "worker environment runtime was not created",
    );
    const manager = enrollmentResult.value;
    const begin = async (id: string) => {
      const record = await provision(startup, id);
      return await manager.begin(record);
    };
    let stopping: Promise<void> | undefined;
    try {
      const first = await begin("first");
      const sameGeneration = await begin("same-generation");
      expect(first.nodeBootstrap.enabledPluginIds).toEqual(["runtime-a"]);
      expect(sameGeneration.nodeBootstrap.sha256).toBe(first.nodeBootstrap.sha256);
      expect(producers).toHaveLength(1);
      expect(producers[0]!.prepare).toHaveBeenCalledWith(first.signal);
      await manager.prepare(startup.store.get("first")!);
      expect(first.signal?.aborted).toBe(false);
      expect(sameGeneration.signal?.aborted).toBe(false);
      manager.close(sameGeneration);
      expect(first.signal?.aborted).toBe(false);

      registry = makeRegistry(metadata, "runtime-b");
      const replacement = await begin("replacement");
      expect(replacement.nodeBootstrap.enabledPluginIds).toEqual(["runtime-b"]);
      expect(replacement.nodeBootstrap.sha256).not.toBe(first.nodeBootstrap.sha256);
      expect(producers[0]!.close).toHaveBeenCalledOnce();
      expect(first.signal?.aborted).toBe(false);
      await expect(fs.readFile(producers[0]!.artifact.tarballPath, "utf8")).resolves.toBe("x");

      metadataSnapshot.mockReturnValue({ ...metadata });
      const refreshed = await begin("metadata-refresh");
      expect(refreshed.nodeBootstrap.sha256).not.toBe(replacement.nodeBootstrap.sha256);
      expect(producers).toHaveLength(3);
      expect(producers[1]!.close).toHaveBeenCalledOnce();
      expect(producers[2]!.prepare).toHaveBeenCalledWith(refreshed.signal);

      manager.close(first);
      producers[0]!.release();
      await producers[0]!.close.mock.results[0]!.value;
      await expect(fs.stat(producers[0]!.artifact.tarballPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const stopped = vi.fn();
      stopping = service.stop().then(stopped);
      await producers[2]!.closing;
      expect([first, replacement, refreshed].map(({ signal }) => signal?.aborted)).toEqual([
        true,
        true,
        true,
      ]);
      producers[2]!.release();
      await producers[2]!.close.mock.results[0]!.value;
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      releaseAll();
      await stopping;
      for (const producer of producers) {
        expect(producer.close).toHaveBeenCalledOnce();
        await expect(fs.stat(producer.artifact.tarballPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      releaseAll();
      await (stopping ?? service.stop());
    }
  });
});
