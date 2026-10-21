import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as stateDbReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { expectObjectFields } from "../test-utils/mock-call-assertions.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync as inspectRecords } from "./installed-plugin-index-record-state.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache as clearRecordsCache,
  loadInstalledPluginIndexInstallRecords as loadRecords,
  loadInstalledPluginIndexInstallRecordsSync as loadRecordsSync,
  readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords,
  recordPluginInstallInRecords as recordInstall,
  removePluginInstallRecordFromRecords as removeRecord,
  withoutPluginInstallRecords as withoutRecords,
} from "./installed-plugin-index-records.js";
import { resolveRetainedManagedNpmInstallPackageInfo } from "./managed-npm-retention.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { seedInstalledPluginIndex as seedIndex } from "./test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = createTempDirTracker();
const makeStateDir = () => tempDirs.make("openclaw-plugin-index-records-");
const seedRecords = (
  stateDir: string,
  records: Record<string, PluginInstallRecord>,
  candidates: PluginCandidate[] = [],
) => seedIndex(records, { stateDir, candidates });
const managedPlugin = (
  stateDir: string,
  pluginId: string,
  version: string,
  packageName = `@openclaw/${pluginId}`,
) => writeManagedNpmPlugin({ stateDir, packageName, pluginId, version });

function createPluginCandidate(stateDir: string, pluginId: string): PluginCandidate {
  const rootDir = path.join(stateDir, "plugins", pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  const source = path.join(rootDir, "index.ts");
  fs.writeFileSync(source, "export function register() {}\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema: { type: "object" } }),
    "utf8",
  );
  return recordPluginCandidateInstallOwner(
    { idHint: pluginId, source, rootDir, origin: "global" },
    pluginId,
  );
}

function managedGeneration(stateDir: string, version = "2026.7.1") {
  return {
    packageName: GENERATION_PACKAGE,
    activePackageDir: writeManaged(stateDir, version, `discord-${version}`),
    stalePackageDir: generationPackagePath(generationProject(stateDir, "discord-2026.6.4")),
  };
}

function npmRecord(packageName: string, version: string, installPath: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${packageName}@${version}`,
    installPath,
    version,
    resolvedName: packageName,
    resolvedVersion: version,
    resolvedSpec: `${packageName}@${version}`,
  };
}
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.doUnmock("./installed-plugin-index-store.js");
  clearRecordsCache();
  tempDirs.cleanup();
});

describe("plugin index install records store", () => {
  it("preserves read errors without recovery or cache poisoning", async () => {
    const stateDir = makeStateDir();
    const records = { authoritative: { source: "npm", spec: "authoritative@1.0.0" } } as const;
    await seedRecords(stateDir, records);
    managedPlugin(stateDir, "recoverable", "1.0.0", "recoverable");
    const error = Object.assign(new Error("plugin index read failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 6,
      errstr: "database table is locked",
    });
    const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
    const scanSpy = vi.spyOn(fs, "readdirSync");
    for (const read of [inspectRecords, loadRecordsSync]) {
      readSpy.mockImplementationOnce(() => {
        throw error;
      });
      await expect
        .soft(
          Promise.resolve().then(() => read({ stateDir })),
          read.name,
        )
        .rejects.toBe(error);
    }
    const asyncReadSpy = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
    for (const read of [readRecords, loadRecords]) {
      asyncReadSpy.mockRejectedValueOnce(error);
      await expect(read({ stateDir })).rejects.toBe(error);
    }
    expect(scanSpy).not.toHaveBeenCalled();
    asyncReadSpy.mockRestore();
    readSpy.mockRestore();
    scanSpy.mockRestore();

    const restored = await loadRecords({ stateDir });
    expect(restored.authoritative).toEqual(records.authoritative);
    expect(restored.recoverable).toMatchObject({ source: "npm", spec: "recoverable@1.0.0" });
    expect(loadRecordsSync({ stateDir })).toEqual(restored);
  });

  it("keeps persisted install record metadata over recovered npm records", async () => {
    const stateDir = makeStateDir();
    const customInstallPath = path.join(stateDir, "custom", "node_modules", "@openclaw", "discord");
    managedPlugin(stateDir, "discord", "2026.5.2");
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/discord@beta",
      installPath: customInstallPath,
      integrity: "sha512-persisted",
    };
    await seedRecords(stateDir, { discord: record }, [createPluginCandidate(stateDir, "discord")]);
    expect((await loadRecords({ stateDir })).discord).toMatchObject(record);
  });

  it("recovers a valid managed generation with an obsolete exact-version selector", async () => {
    const recoveredVersion = "2026.7.1";
    const stateDir = makeStateDir();
    const { packageName, stalePackageDir, activePackageDir } = managedGeneration(stateDir);
    await seedRecords(stateDir, {
      discord: {
        ...npmRecord(packageName, "2026.6.4", stalePackageDir),
        integrity: "sha512-stale",
      },
    });

    expectObjectFields((await loadRecords({ stateDir })).discord, {
      ...npmRecord(packageName, recoveredVersion, activePackageDir),
      integrity: undefined,
    });

    clearRecordsCache();
    expect(loadRecordsSync({ stateDir }).discord).toMatchObject({
      installPath: activePackageDir,
      resolvedVersion: recoveredVersion,
    });
  });

  it("recovers a Windows managed generation when the persisted root casing differs", async () => {
    const stateDir = makeStateDir();
    const { packageName, activePackageDir, stalePackageDir } = managedGeneration(stateDir);

    await seedRecords(stateDir, {
      discord: {
        source: "npm",
        spec: "@openclaw/discord@latest",
        installPath: stalePackageDir.replace(stateDir, stateDir.toUpperCase()),
        resolvedName: packageName,
        resolvedVersion: "2026.6.4",
      },
    });

    // Platform spoofing changes the coordinator directory captured by the seeded worker.
    await closeOpenClawStateDatabaseAsync();
    const loaded = await withMockedWindowsPlatform(() => loadRecords({ stateDir }));
    expect(loaded.discord).toMatchObject({
      installPath: activePackageDir,
      resolvedVersion: "2026.7.1",
    });
  });

  it("recovers managed npm metadata when the persisted record points at an older package version", async () => {
    const stateDir = makeStateDir();
    const codexDir = managedPlugin(stateDir, "codex", "2026.5.18-beta.1");
    await seedRecords(
      stateDir,
      {
        codex: {
          ...npmRecord("@openclaw/codex", "2026.5.16-beta.1", codexDir),
          integrity: "sha512-stale",
          shasum: "stale",
          installedAt: "2026-05-16T01:42:54.609Z",
          resolvedAt: "2026-05-16T01:42:52.981Z",
        },
      },
      [createPluginCandidate(stateDir, "codex")],
    );

    expectObjectFields((await loadRecords({ stateDir })).codex, {
      ...npmRecord("@openclaw/codex", "2026.5.18-beta.1", codexDir),
      integrity: undefined,
      shasum: undefined,
      installedAt: undefined,
      resolvedAt: undefined,
    });

    expect(loadRecordsSync({ stateDir }).codex).toMatchObject({
      version: "2026.5.18-beta.1",
      resolvedVersion: "2026.5.18-beta.1",
    });
  });

  it("updates and removes records without mutating caller state", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const keep = { source: "npm" as const, spec: "keep@1.0.0" };
    const entries = [
      ["keep", keep],
      ["constructor", { source: "path" }],
      ["toString", { source: "git" }],
      ["__proto__", { source: "archive" }],
    ] as const;
    for (const [id, record] of entries) {
      setPluginInstallRecordMapEntry(records, id, record);
    }
    const withInstall = recordInstall(records, {
      pluginId: "demo",
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(Object.getPrototypeOf(withInstall)).toBeNull();
    expect(Object.keys(records)).toEqual(["keep", "constructor", "toString", "__proto__"]);
    expect(withInstall.demo).toMatchObject({
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    const removed = removeRecord(withInstall, "demo");
    expect(removed).toEqual(records);
    expect(Object.getPrototypeOf(removed)).toBeNull();
    for (const [id, record] of entries) {
      expect(getPluginInstallRecordMapEntry(withInstall, id)).toBe(record);
      expect(getPluginInstallRecordMapEntry(removed, id)).toBe(record);
    }
    const withoutProto = removeRecord(removed, "__proto__");
    expect(Object.hasOwn(withoutProto, "__proto__")).toBe(false);
    for (const [id, record] of entries.slice(1, 3)) {
      expect(getPluginInstallRecordMapEntry(withoutProto, id)).toBe(record);
    }
  });

  it("preserves an authored empty plugins section while stripping transient install records", () => {
    expect(
      withoutRecords(
        { plugins: { installs: { twitch: { source: "npm", spec: "twitch@1.0.0" } } } },
        { preserveEmptyPlugins: true },
      ),
    ).toEqual({ plugins: {} });
  });

  it("returns empty records when the persisted plugin index is missing", async () => {
    const stateDir = makeStateDir();

    expect(await readRecords({ stateDir })).toBeNull();
    const records = await loadRecords({ stateDir });
    expect(Object.keys(records)).toEqual([]);
    expect(Object.getPrototypeOf(records)).toBeNull();
  });
});

const GENERATION_PACKAGE = "@openclaw/discord";
const GENERATION_PLUGIN = "discord";
function generationPackagePath(projectRoot: string) {
  return path.join(projectRoot, "node_modules", ...GENERATION_PACKAGE.split("/"));
}

const generationProject = (stateDir: string, generationKey: string) =>
  resolvePluginNpmGenerationProjectDir({
    npmDir: path.join(stateDir, "npm"),
    packageName: GENERATION_PACKAGE,
    generationKey,
  });

function writeManaged(stateDir: string, version: string, generationKey?: string): string {
  const packageDir = managedPlugin(stateDir, GENERATION_PLUGIN, version);
  if (!generationKey) {
    return packageDir;
  }
  const flatProjectRoot = resolvePluginNpmProjectDir({
    npmDir: path.join(stateDir, "npm"),
    packageName: GENERATION_PACKAGE,
  });
  const generationProjectRoot = generationProject(stateDir, generationKey);
  fs.renameSync(flatProjectRoot, generationProjectRoot);
  return generationPackagePath(generationProjectRoot);
}

function seedAuthority(stateDir: string, installPath: string, dangling = false) {
  return seedIndex(
    {
      discord: {
        source: "npm",
        installPath,
        resolvedName: GENERATION_PACKAGE,
        spec: `${GENERATION_PACKAGE}@${dangling ? "latest" : "1.0.0"}`,
        resolvedVersion: dangling ? "2.0.0" : "1.0.0",
        ...(!dangling ? { version: "1.0.0", resolvedSpec: `${GENERATION_PACKAGE}@1.0.0` } : {}),
      },
    },
    { stateDir, candidates: [] },
  );
}

function orderInstalls(older: string, newer: string) {
  setInstallTimestamp(older, Date.UTC(2026, 0, 1));
  setInstallTimestamp(newer, Date.UTC(2026, 0, 2));
}

async function expectRecovered(stateDir: string, installPath: string, resolvedVersion = "1.0.0") {
  const loaded = await loadRecords({ stateDir });
  expect(loaded.discord).toMatchObject({ installPath, resolvedVersion });
}

function setInstallTimestamp(packageDir: string, timestampMs: number): void {
  const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
  if (!packageInfo) {
    throw new Error(`Expected managed npm package dir: ${packageDir}`);
  }
  const timestamp = new Date(timestampMs);
  for (const dir of [packageDir, packageInfo.projectRoot]) {
    fs.utimesSync(path.join(dir, "package.json"), timestamp, timestamp);
    fs.utimesSync(dir, timestamp, timestamp);
  }
}

describe("managed npm generation-dir loader precedence", () => {
  afterEach(() => vi.restoreAllMocks());
  it("matches the authoritative generation case-insensitively on Windows", async () => {
    const stateDir = makeStateDir();
    const newerPackageDir = writeManaged(stateDir, "3.0.0", "discord-newer-on-windows");
    const downgradedPackageDir = writeManaged(stateDir, "1.0.0");
    orderInstalls(downgradedPackageDir, newerPackageDir);
    const differentlyCasedActivePath = downgradedPackageDir.replace(
      stateDir,
      stateDir.toUpperCase(),
    );

    await seedAuthority(stateDir, differentlyCasedActivePath);
    // Prepare native storage before simulating Windows path comparisons in the loader.
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const loaded = await loadRecords({ stateDir });
    expect(loaded.discord).toMatchObject({ resolvedVersion: "1.0.0" });
    expect(String(loaded.discord?.installPath).toLowerCase()).toBe(
      downgradedPackageDir.toLowerCase(),
    );
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("warns when install recency replaces a dangling managed authority", async () => {
    const stateDir = makeStateDir();
    const recentPackageDir = writeManaged(stateDir, "1.0.0", "discord-recent-after-dangling");
    const olderPackageDir = writeManaged(stateDir, "9.0.0");
    orderInstalls(olderPackageDir, recentPackageDir);
    const missingPackageDir = generationPackagePath(generationProject(stateDir, "discord-missing"));
    await seedAuthority(stateDir, missingPackageDir, true);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await expectRecovered(stateDir, recentPackageDir);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("without an authoritative active path"),
      expect.objectContaining({ code: "OPENCLAW_PLUGIN_INSTALL_RECOVERY_FALLBACK" }),
    );
  });

  it("does not treat unrelated legacy-root metadata changes as plugin recency", async () => {
    const stateDir = makeStateDir();
    const recentPackageDir = writeManaged(stateDir, "1.0.0", "discord-recent-from-legacy");
    const olderPackageDir = writeManagedNpmPlugin({
      stateDir,
      packageName: GENERATION_PACKAGE,
      pluginId: GENERATION_PLUGIN,
      version: "9.0.0",
      layout: "legacy",
    });
    orderInstalls(olderPackageDir, recentPackageDir);
    writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/unrelated",
      pluginId: "unrelated",
      version: "1.0.0",
      layout: "legacy",
    });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await expectRecovered(stateDir, recentPackageDir);
  });
});

type Counts = { opens: number; reads: number };
describe("managed npm manifest reads", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ["project", "async"],
    ["legacy", "sync"],
  ] as const)("reads managed npm manifests once during %s %s recovery", async (layout, mode) => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const packageName = "@fixture/install-key";
    const packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "fixture-plugin",
      version: "1.2.3",
      dependencySpec: "latest",
      layout,
    });
    const packagePath = path.join(packageDir, "package.json");
    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        name: "@fixture/package-name",
        version: " 1.2.3 ",
        openclaw: { extensions: ["./dist/index.js"] },
      }),
    );
    const projectRoot =
      layout === "legacy"
        ? path.join(stateDir, "npm")
        : resolvePluginNpmProjectDir({ npmDir: path.join(stateDir, "npm"), packageName });
    const counts = new Map<string, Counts>(
      [
        packagePath,
        path.join(packageDir, "openclaw.plugin.json"),
        path.join(projectRoot, "package.json"),
      ].map((file) => [file, { opens: 0, reads: 0 }]),
    );
    const descriptors = new Map<number, { counts: Counts; start: number }>();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    clearRecordsCache();
    const readFile = vi.spyOn(fs, "readFileSync");
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, permissions) => {
      const fd = originalOpen(file, flags, permissions);
      const fileCounts = counts.get(String(file));
      if (fileCounts) {
        fileCounts.opens++;
        descriptors.set(fd, { counts: fileCounts, start: readFile.mock.calls.length });
      }
      return fd;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      const tracked = descriptors.get(fd);
      if (tracked) {
        tracked.counts.reads += readFile.mock.calls
          .slice(tracked.start)
          .filter(([file]) => file === fd).length;
        descriptors.delete(fd);
      }
      return originalClose(fd);
    });
    const read = mode === "async" ? loadRecords : loadRecordsSync;
    const expected = {
      "fixture-plugin": {
        source: "npm",
        spec: `${packageName}@latest`,
        installPath: packageDir,
        version: "1.2.3",
        resolvedName: packageName,
        resolvedVersion: "1.2.3",
        resolvedSpec: `${packageName}@1.2.3`,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await read({ stateDir })).toEqual(expected);
      expect(descriptors.size).toBe(0);
      for (const [file, observed] of counts) {
        expect(observed, file).toEqual({ opens: 1, reads: 1 });
      }
    }
  });
});
