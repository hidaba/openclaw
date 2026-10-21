import { mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withRestoredMocks } from "../test-utils/vitest-spies.js";
import { resolveCurrentOpenClawCliInvocation } from "./openclaw-cli-invocation.js";
import { withSourceCliParent } from "./openclaw-cli-invocation.test-support.js";

const requireFromHere = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const repoSourceEntry = path.join(repoRoot, "src", "entry.ts");
const trustedTsxLoader = pathToFileURL(requireFromHere.resolve("tsx", { paths: [repoRoot] })).href;
const sourceEnv = { TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") };
const commandArgs = ["sessions", "export-trajectory"];
type Invocation = ReturnType<typeof resolveCurrentOpenClawCliInvocation>;
type Options = { entryPath: string; cwd?: string; execArgv?: string[]; execPath?: string };
const invoke = (options: Options, args = commandArgs) =>
  withRestoredMocks(
    [
      vi.spyOn(process, "cwd").mockReturnValue(options.cwd ?? repoRoot),
      vi.spyOn(process, "execPath", "get").mockReturnValue(options.execPath ?? "/usr/bin/node"),
      vi.spyOn(process, "versions", "get").mockReturnValue({
        ...process.versions,
        bun: options.execPath === "/usr/local/bin/bun" ? "1.3.0" : undefined,
      }),
    ],
    () =>
      withSourceCliParent(
        { entryPath: options.entryPath, execArgv: options.execArgv ?? process.execArgv },
        () => resolveCurrentOpenClawCliInvocation(args),
      ),
  );
function expectInvocation(options: Options, expected: Partial<Invocation>) {
  expect(invoke(options)).toEqual({ command: "/usr/bin/node", cwd: repoRoot, ...expected });
}
const writePackage = (root: string) =>
  writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');

it.each([true, false])("uses standalone sidecar (sidecar cwd=%s)", async (sidecarCwd) => {
  const root = tempDirs.make("openclaw-cli-standalone-");
  const packageRoot = path.join(root, "runtime");
  await mkdir(packageRoot);
  const execPath = path.join(root, "openclaw");
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "aot",
      executable: { path: "openclaw" },
      runtime: { path: "runtime" },
      openclaw: { version: "2026.10.15" },
      bun: { version: "1.3.0" },
    }),
  );
  expectInvocation(
    {
      execPath,
      entryPath: sidecarCwd ? path.join(packageRoot, "openclaw.mjs") : "/$bunfs/root/cli.js",
      execArgv: ["--trace-warnings"],
      cwd: sidecarCwd ? root : repoRoot,
    },
    { command: execPath, args: commandArgs, cwd: packageRoot },
  );
});

it.each([false, true])("pins TSX but not debugger ownership (equals=%s)", (equals) => {
  const runtimeArgs = ["--trace-warnings", "--import", "/other-loader.mjs"];
  const invocation = invoke({
    entryPath: repoSourceEntry,
    execArgv: [
      ...runtimeArgs,
      "--inspect",
      "127.0.0.1:9231",
      "--inspect-brk=0",
      "--inspect-wait=0",
      "--inspect-port",
      "9230",
      "--inspect-port=9232",
      ...(equals ? ["--import=tsx"] : ["--import", "tsx"]),
    ],
    execPath: resolveTestNodeExecPath(),
  });
  expect(invocation.args).toEqual([
    ...runtimeArgs,
    ...(equals ? [`--import=${trustedTsxLoader}`] : ["--import", trustedTsxLoader]),
    repoSourceEntry,
    ...commandArgs,
  ]);
});

it.each(["openclaw.mjs", path.join("dist", "index.js")])(
  "pins a prepared %s invocation across an installation switch",
  async (entryName) => {
    const root = tempDirs.make("openclaw-cli-release-switch-");
    const releaseA = path.join(root, "release-a");
    const releaseB = path.join(root, "release-b");
    for (const release of [releaseA, releaseB]) {
      await mkdir(path.join(release, "dist"), { recursive: true });
      await writePackage(release);
      await writeFile(path.join(release, entryName), "export {};\n");
    }
    const current = path.join(root, "current");
    await symlink(releaseA, current, "junction");
    const options = {
      entryPath: path.join(current, entryName),
      cwd: root,
      execPath: resolveTestNodeExecPath(),
      execArgv: [],
    };
    const prepared = invoke(options, ["--version"]);

    await unlink(current);
    await symlink(releaseB, current, "junction");

    const expectRelease = async (invocation: Invocation, release: string) => {
      const entry = await realpath(expectDefined(invocation.args[0], "CLI entry"));
      expect([entry, invocation.cwd]).toEqual([path.join(release, entryName), release]);
    };
    await expectRelease(prepared, releaseA);
    await expectRelease(invoke(options, ["--version"]), releaseB);
  },
);

it.each(["Bun source", "installed wrapper", "foreign entry"])("resolves %s", async (kind) => {
  const installed = kind === "installed wrapper";
  const bun = kind === "Bun source";
  const root = installed ? tempDirs.make("openclaw-cli-invocation-") : repoRoot;
  if (installed) {
    await writePackage(root);
  }
  const command = bun ? "/usr/local/bin/bun" : "/usr/bin/node";
  const options = installed
    ? {
        entryPath: path.join(root, "bin", "host.mjs"),
        cwd: path.join(root, "state"),
      }
    : { entryPath: bun ? path.join(root, "scripts", "test-live.mts") : "/app/dist/index.js" };
  const entryArgs = installed
    ? [path.join(root, "openclaw.mjs")]
    : bun
      ? ["--no-install", repoSourceEntry]
      : ["--import", trustedTsxLoader, repoSourceEntry];
  const args = [...entryArgs, ...commandArgs];
  const env = kind === "foreign entry" ? sourceEnv : undefined;
  expectInvocation({ ...options, execPath: command }, { command, cwd: root, args, env });
});
