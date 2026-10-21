import { describe, expect, it } from "vitest";
import { useManifestLoader } from "./manifest-metadata.test-support.js";
const load = useManifestLoader({}, { mode: 0o755 });
const cli = { id: "anthropic", providers: ["anthropic"], cliBackends: ["claude-cli"] };

describe("plugin manifest model catalog", () => {
  it.each([true, false])("loads models.dev opt-in only with provider ownership: %s", (owned) => {
    const manifest = load({
      id: "example-plugin",
      providers: owned ? [" Example "] : [],
      modelCatalog: { modelsDev: { " EXAMPLE ": " upstream-id ", other: "other-source" } },
    });
    expect(manifest.modelCatalog).toEqual(
      owned ? { modelsDev: { example: "upstream-id" } } : undefined,
    );
  });

  it("allows cli backends to own manifest model catalog rows", () => {
    const modelCatalog = {
      providers: { "claude-cli": { models: [{ id: "claude-sonnet-4-6" }] } },
      discovery: { "claude-cli": "static" },
    };
    expect(load({ ...cli, modelCatalog }).modelCatalog).toEqual(modelCatalog);
  });

  it("allows cli backends to own pricing policy", () => {
    const manifest = load({
      ...cli,
      modelPricing: {
        providers: {
          "claude-cli": { priceAs: " Anthropic " },
          unowned: { priceAs: "anthropic" },
        },
      },
    });
    expect(manifest.modelPricing?.providers).toEqual({
      "claude-cli": { priceAs: "anthropic" },
    });
  });

  it("normalizes owned request policies at the manifest boundary", () => {
    const manifest = load({
      id: "example-plugin",
      providers: [" Demo ", "bad"],
      providerRequest: {
        providers: {
          " DEMO ": {
            family: " demo-family ",
            compatibilityFamily: " moonshot ",
            openAICompletions: { supportsStreamingUsage: true },
          },
          unowned: { family: "ignored-family" },
          bad: [],
        },
      },
    });
    expect(manifest.providerRequest).toEqual({
      providers: {
        demo: {
          family: "demo-family",
          compatibilityFamily: "moonshot",
          openAICompletions: { supportsStreamingUsage: true },
        },
      },
    });
  });
});
