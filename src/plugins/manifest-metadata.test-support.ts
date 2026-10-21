import fs from "node:fs";
import path from "node:path";
import { afterEach, assert } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

export function useManifestLoader(
  defaults: Record<string, unknown> = {},
  options: { coldRuntime?: boolean; mode?: number } = {},
) {
  const roots = useAutoCleanupTempDirTracker(afterEach);
  return (content: Record<string, unknown> | string, rejectHardlinks = true) => {
    const root = roots.make("manifest-metadata-");
    if (options.mode !== undefined && process.platform !== "win32") {
      fs.chmodSync(root, options.mode);
    }
    if (options.coldRuntime) {
      fs.writeFileSync(path.join(root, "index.js"), "throw new Error('runtime must stay cold');");
    }
    fs.writeFileSync(
      path.join(root, "openclaw.plugin.json"),
      typeof content === "string"
        ? content
        : JSON.stringify({
            id: "test-plugin",
            configSchema: { type: "object" },
            ...defaults,
            ...content,
          }),
    );
    const result = loadPluginManifest(root, rejectHardlinks);
    assert(result.ok);
    return result.manifest;
  };
}
