import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";

const mocks = vi.hoisted(() => ({
  readBundledDiscoveryMode: vi.fn<() => "compat" | "allowlist" | undefined>(() => "allowlist"),
}));

vi.mock("./bundled-discovery-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundled-discovery-state.js")>();
  return {
    ...actual,
    readBundledDiscoveryMode: mocks.readBundledDiscoveryMode,
    readBundledDiscoveryModeMemoized: (env?: NodeJS.ProcessEnv) =>
      actual.readBundledDiscoveryModeMemoized(env, {}, mocks.readBundledDiscoveryMode),
  };
});

type Eligibility = typeof import("./manifest-contract-eligibility.js");
let isAvailable: Eligibility["isManifestPluginAvailableForControlPlane"];
let listPlugins: Eligibility["listAvailableManifestContractPlugins"];
let listValues: Eligibility["listAvailableManifestContractValues"];
let clearPluginMetadataLifecycleCaches: typeof import("./plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
let makePluginMetadataIndex: typeof import("./current-plugin-metadata.test-support.js").makePluginMetadataIndex;
let makePluginMetadataManifestRegistry: typeof import("./current-plugin-metadata.test-support.js").makePluginMetadataManifestRegistry;

beforeAll(async () => {
  // The plugins project shares module state across files. Rebind this module graph
  // after the hoisted mocks so an earlier production import cannot bypass them.
  vi.resetModules();
  ({
    isManifestPluginAvailableForControlPlane: isAvailable,
    listAvailableManifestContractPlugins: listPlugins,
    listAvailableManifestContractValues: listValues,
  } = await import("./manifest-contract-eligibility.js"));
  ({ clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js"));
  ({ makePluginMetadataIndex, makePluginMetadataManifestRegistry } =
    await import("./current-plugin-metadata.test-support.js"));
});

describe("bundled manifest contract availability", () => {
  const plugin = {
    id: "google",
    origin: "bundled" as const,
    contracts: { imageGenerationProviders: ["google"] },
  };
  const index = { plugins: [{ pluginId: "google", origin: "bundled", enabled: false }] };
  const snapshot = {
    index,
    plugins: [plugin],
  } as never;
  const available = (params: Partial<Parameters<typeof isAvailable>[0]>) =>
    isAvailable({ snapshot, plugin, ...params });
  const values = (config: OpenClawConfig) =>
    listValues({ snapshot, contract: "imageGenerationProviders", config });

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    mocks.readBundledDiscoveryMode.mockReset();
    mocks.readBundledDiscoveryMode.mockReturnValue("allowlist");
  });

  it("does not expose a plugin outside a restrictive allowlist", () => {
    const config = { plugins: { allow: ["another-plugin"] } };
    expect(available({ config, allowBundledProviderCompat: true })).toBe(false);
    expect(values(config)).toEqual([]);
  });

  it.each([
    ["custom-owner", "private-channel", { enabled: true }, {}, true],
    ["discord-owner", "discord", { enabled: false, token: "configured" }, {}, false],
    ["discord-owner", "discord", { token: "configured" }, { deny: ["discord-owner"] }, false],
    [
      "discord-owner",
      "discord",
      { token: "configured" },
      { entries: { "discord-owner": { enabled: false } } },
      false,
    ],
  ] satisfies Array<
    [
      string,
      string,
      { enabled?: boolean; token?: string },
      NonNullable<OpenClawConfig["plugins"]>,
      boolean,
    ]
  >)("honors %s / %s: channel=%j policy=%j -> %s", (id, channel, config, policy, expected) => {
    expect(
      available({
        plugin: { ...plugin, id, channels: [channel] },
        config: {
          plugins: { allow: ["another-plugin"], ...policy },
          channels: { [channel]: config },
        },
      }),
    ).toBe(expected);
    if (expected) {
      expect(mocks.readBundledDiscoveryMode).not.toHaveBeenCalled();
    }
  });

  it("preserves globally disabled bundled metadata for the named speech compatibility path", () => {
    const config = { plugins: { enabled: false } };
    const normalizedConfig = normalizePluginsConfig(config.plugins);
    expect(available({ config, normalizedConfig })).toBe(true);
    expect(values(config)).toEqual(["google"]);
    expect(normalizedConfig.enabled).toBe(false);
  });

  it("preserves the shipped provider-contract compatibility mode", () => {
    mocks.readBundledDiscoveryMode.mockReturnValue("compat");

    expect(
      available({
        config: { plugins: { allow: ["another-plugin"] } },
        allowBundledProviderCompat: true,
      }),
    ).toBe(true);
  });

  it.each([{ entries: { google: { enabled: false } } }, { deny: ["google"] }])(
    "never bypasses explicit owner prohibition in bundled compatibility mode",
    (plugins) => {
      mocks.readBundledDiscoveryMode.mockReturnValue("compat");

      expect(
        available({
          config: { plugins },
          allowBundledProviderCompat: true,
        }),
      ).toBe(false);
    },
  );

  it("keeps non-provider manifest contracts behind the allowlist", () => {
    mocks.readBundledDiscoveryMode.mockReturnValue("compat");
    const nonProviderPlugin = {
      ...plugin,
      contracts: { documentExtractors: ["document"] },
    };
    expect(
      listValues({
        snapshot: { index, plugins: [nonProviderPlugin] } as never,
        contract: "documentExtractors",
        config: { plugins: { allow: ["another-plugin"] } },
      }),
    ).toEqual([]);
  });
});

describe("prepared installed-plugin eligibility", () => {
  it.each<{ config: OpenClawConfig | undefined; expected: boolean[] }>([
    { config: undefined, expected: [true, false, false] },
    { config: {}, expected: [false, false, false] },
  ])("preserves policy and first-record selection for $config", ({ config, expected }) => {
    clearPluginMetadataLifecycleCaches();
    mocks.readBundledDiscoveryMode.mockReturnValue("allowlist");
    const index = makePluginMetadataIndex("workspace");
    const workspace = { ...index.plugins[0]!, origin: "workspace" as const };
    const duplicate = {
      ...makePluginMetadataIndex("duplicate").plugins[0]!,
      origin: "workspace" as const,
      enabled: false,
    };
    index.plugins = [workspace, duplicate, { ...duplicate, origin: "global", enabled: true }];
    const manifestPlugins = ["workspace", "duplicate", "missing"].flatMap((id) =>
      makePluginMetadataManifestRegistry(id).plugins.map((plugin) =>
        Object.assign({}, plugin, {
          origin: id === "missing" ? ("global" as const) : ("workspace" as const),
          contracts: { imageGenerationProviders: [id] },
        }),
      ),
    );
    expect(
      manifestPlugins.map((plugin) => isAvailable({ snapshot: { index }, config, plugin })),
    ).toEqual(expected);
    const expectedPlugins = manifestPlugins.filter((_plugin, position) => expected[position]);
    const available = listPlugins({
      snapshot: { index, plugins: manifestPlugins },
      config,
      contract: "imageGenerationProviders",
    });
    expect(available).toHaveLength(expectedPlugins.length);
    available.forEach((plugin, position) => expect(plugin).toBe(expectedPlugins[position]));
  });
});
