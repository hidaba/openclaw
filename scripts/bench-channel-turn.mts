import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  openSync,
  readSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { startQaBusServer, createQaBusState } from "../extensions/qa-lab/bus-api.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { ExecApprovalUsageAuthorization } from "../src/infra/exec-approvals-contracts.js";
import type { ExecApprovalsFile } from "../src/infra/exec-approvals-core.js";
import { buildCwdBoundHashedArgPattern } from "../src/infra/exec-command-resolution.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  readGatewayGcTrace,
  readGatewayHeapProfile,
  startGatewayDiagnostics,
} from "./lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  parsePositiveInt,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
const EXEC_POLICY_MARKER = "synthetic-exec-policy";
const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    "exec-policy-rules": { type: "string" },
    "exec-policy-only": { type: "boolean" },
    iterations: { type: "string", default: "1000" },
    samples: { type: "string", default: "5" },
    "start-at": { type: "string" },
    "steady-duration-ms": { type: "string" },
    "steady-turns": { type: "string", default: "100" },
    "warmup-ms": { type: "string" },
    allocations: { type: "boolean" },
    "prepare-only": { type: "boolean" },
    "prepared-fixture": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --expose-gc --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts [--entry dist/entry.js] [--exec-policy-rules 100|1000] [--exec-policy-only --iterations 1000 --samples 5] [--warmup-ms 120000 --steady-duration-ms 480000 --steady-turns 100 --allocations] [--prepare-only | --prepared-fixture <output-dir>] [--start-at <epoch-ms>]\nRuns one cold and ten warmed QA-channel turns. Steady mode measures at least the requested duration and turn count, with main-isolate GC and loop diagnostics; --allocations samples collected objects in that same window. --start-at synchronizes the measured phase after warm-up. --prepare-only creates synthetic state without starting servers. Exec policy mode verifies one real exec call per turn; --exec-policy-only measures the retained final guard without a Gateway.",
  );
  process.exit(0);
}
const ruleCount = values["exec-policy-rules"]
  ? parsePositiveInt(values["exec-policy-rules"], 100, "exec-policy-rules")
  : undefined;
if (ruleCount !== undefined && ruleCount !== 100 && ruleCount !== 1000) {
  throw new Error("--exec-policy-rules must be 100 or 1000");
}
if (values["exec-policy-only"] && ruleCount === undefined) {
  throw new Error("--exec-policy-only requires --exec-policy-rules");
}
const steadyDurationMs = values["steady-duration-ms"]
  ? parsePositiveInt(values["steady-duration-ms"], 120000, "steady-duration-ms")
  : 0;
const steadyTurns = parsePositiveInt(values["steady-turns"], 100, "steady-turns");
const warmupMs = values["warmup-ms"]
  ? parsePositiveInt(values["warmup-ms"], 120000, "warmup-ms")
  : 0;
if (steadyDurationMs && values["exec-policy-only"]) {
  throw new Error("--steady-duration-ms requires the Gateway workload");
}
if ((values.allocations || warmupMs) && !steadyDurationMs) {
  throw new Error("--allocations and --warmup-ms require --steady-duration-ms");
}
if (values["exec-policy-only"] && (values["prepare-only"] || values["prepared-fixture"])) {
  throw new Error("Fixture preparation requires the Gateway workload");
}
const output = values["prepared-fixture"]
  ? path.resolve(values["prepared-fixture"])
  : mkdtempSync(path.join(tmpdir(), "sqlmeasure-channel-"));
const fixture = path.join(output, "fixture");
if (!values["prepared-fixture"]) {
  mkdirSync(fixture);
}
if (values["exec-policy-only"] && ruleCount !== undefined) {
  console.log("OUTPUT", output);
  const result = await measureExecPolicy(ruleCount);
  writeFileSync(path.join(output, "evidence.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exit(0);
}

function syntheticExecPolicy(count: number): ExecApprovalsFile {
  const executable = realpathSync("/bin/echo");
  const argPattern = buildCwdBoundHashedArgPattern(
    [executable, EXEC_POLICY_MARKER],
    path.join(fixture, "workspace"),
  );
  const allowlist = Array.from({ length: count }, (_, index) => ({
    id: `synthetic-rule-${index}`,
    pattern: index === 0 ? executable : `/synthetic/bin/tool-${index}`,
    argPattern,
    ...(index % 2 === 0 ? { source: "allow-always" as const } : {}),
  }));
  return {
    version: 1,
    defaults: {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agents: {
      main: { allowlist: allowlist.slice(0, count / 2) },
      "*": { allowlist: allowlist.slice(count / 2) },
    },
  };
}

async function openExecPolicyFixture(stateDir: string, count: number) {
  const [
    { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync },
    { writeExecApprovalsConfigRow },
    { captureOpenClawStateWorkerContext },
  ] = await Promise.all([
    import("../src/state/openclaw-state-db.js"),
    import("../src/infra/exec-approvals-sqlite.js"),
    import("../src/state/openclaw-state-worker-context.js"),
  ]);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const file = syntheticExecPolicy(count);
  const source = openOpenClawStateDatabase({ env });
  writeExecApprovalsConfigRow({ db: source.db, file });
  return {
    file,
    context: captureOpenClawStateWorkerContext({ env }),
    close: closeOpenClawStateDatabaseAsync,
  };
}

async function measureExecPolicy(count: number) {
  const iterations = parsePositiveInt(values.iterations, 1000, "iterations");
  const samples = parsePositiveInt(values.samples, 5, "samples");
  const [
    { recordAllowlistMatchesUse },
    { createExecApprovalPolicySnapshot },
    { updateExecApprovals },
  ] = await Promise.all([
    import("../src/infra/exec-approvals-authorization.js"),
    import("../src/infra/exec-approvals-allow-always.js"),
    import("../src/infra/exec-approvals-store.js"),
  ]);
  const owner = await openExecPolicyFixture(path.join(fixture, "state"), count);
  const entry = owner.file.agents!.main!.allowlist![0]!;
  const authorize = (source: ExecApprovalUsageAuthorization["source"]) =>
    recordAllowlistMatchesUse(
      {
        agentId: "main",
        command: `${entry.pattern} ${EXEC_POLICY_MARKER}`,
        matches: [entry],
        authorization: {
          source,
          security: "allowlist",
          ask: "on-miss",
          allowlistSatisfied: true,
          requireDurableAllowlistApproval: true,
          policySnapshot: createExecApprovalPolicySnapshot({ file: owner.file, agentId: "main" }),
        },
      },
      owner.context,
    );
  const metrics = [];
  const matrix: { policy: string; source: string; allowed: boolean }[] = [];
  try {
    await waitForBenchmarkStart();
    for (const source of ["current-policy", "explicit-approval"] as const) {
      const preparationStart = performance.now();
      const guard = await authorize(source);
      const preparationMs = performance.now() - preparationStart;
      const coldStart = performance.now();
      guard();
      const firstCheckMs = performance.now() - coldStart;
      const nativeClone = globalThis.structuredClone;
      let cloneCalls = 0;
      try {
        globalThis.structuredClone = (value, options) => {
          cloneCalls++;
          return nativeClone(value, options);
        };
        for (let index = 0; index < 10; index++) {
          guard();
        }
      } finally {
        globalThis.structuredClone = nativeClone;
      }
      const observations = [];
      for (let sample = 0; sample < samples; sample++) {
        const start = performance.now();
        for (let index = 0; index < iterations; index++) {
          guard();
        }
        const msPerCheck = (performance.now() - start) / iterations;
        globalThis.gc?.();
        const profiler = new Session();
        profiler.connect();
        try {
          await profiler.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          for (let index = 0; index < iterations; index++) {
            guard();
          }
          const { profile } = await profiler.post("HeapProfiler.stopSampling");
          writeFileSync(
            path.join(output, `${source}-${sample}.heapprofile`),
            JSON.stringify(profile),
          );
          const pending = [{ node: profile.head, category: "other" }];
          const allocationBytes: Record<string, number> = {};
          for (const { node, category } of pending) {
            const name = node.callFrame.functionName;
            const ownerCategory = [
              "structuredClone",
              "normalizeExecApprovalsInternal",
              "createExecApprovalPolicySnapshot",
            ].includes(name)
              ? name
              : category;
            allocationBytes[ownerCategory] = (allocationBytes[ownerCategory] ?? 0) + node.selfSize;
            for (const child of node.children) {
              pending.push({ node: child, category: ownerCategory });
            }
          }
          observations.push({
            msPerCheck,
            estimatedAllocatedBytesPerCheck:
              Object.values(allocationBytes).reduce((total, bytes) => total + bytes, 0) /
              iterations,
            sampledAllocationBytesPerCheck: Object.fromEntries(
              Object.entries(allocationBytes).map(([name, bytes]) => [name, bytes / iterations]),
            ),
          });
        } finally {
          profiler.disconnect();
        }
      }
      metrics.push({
        source,
        preparationMs,
        firstCheckMs,
        structuredClonesPerCheck: cloneCalls / 10,
        msPerCheck: summarizeNumbers(observations.map((sample) => sample.msPerCheck)),
        estimatedAllocatedBytesPerCheck: summarizeNumbers(
          observations.map((sample) => sample.estimatedAllocatedBytesPerCheck),
        ),
        observations,
      });
    }
    const guards = await Promise.all(
      (["current-policy", "explicit-approval", "auto-review"] as const).map(async (source) => ({
        source,
        guard: await authorize(source),
      })),
    );
    for (const [policy, allowed] of [
      ["unchanged", true],
      ["metadata", true],
      ["additive", true],
      ["source-upgrade", true],
      ["source-downgrade", false],
      ["revoked", false],
      ["deny", false],
      ["always-ask", false],
    ] as const) {
      const file = syntheticExecPolicy(count);
      const rules = file.agents!.main!.allowlist!;
      if (policy === "metadata") {
        rules[0]!.lastUsedAt = Date.now() + 1;
      }
      if (policy === "additive") {
        rules.push({ pattern: "/synthetic/bin/additional" });
      }
      if (policy === "source-upgrade") {
        rules[1]!.source = "allow-always";
      }
      if (policy === "source-downgrade") {
        delete rules[0]!.source;
      }
      if (policy === "revoked") {
        rules.shift();
      }
      if (policy === "deny") {
        file.defaults!.security = "deny";
      }
      if (policy === "always-ask") {
        file.defaults!.ask = "always";
      }
      await updateExecApprovals({ update: { kind: "replace", file } }, owner.context);
      for (const { source, guard } of guards) {
        let observed = true;
        try {
          guard();
        } catch {
          observed = false;
        }
        matrix.push({ policy, source, allowed: observed });
        if (observed !== allowed) {
          throw new Error(
            `Exec policy matrix mismatch: ${policy}/${source} expected allowed=${allowed}`,
          );
        }
      }
    }
    return {
      output,
      harnessVersion: "3.0.0-exec-policy.1",
      node: process.version,
      workload: "retained-exec-authorization-final-guard",
      ruleCount: count,
      iterations,
      samples,
      allocationScope:
        "Main isolate final guard only; commit/worker/tool execution excluded. Collected-object sampling estimates allocations, not exact normalization call counts.",
      metrics,
      matrix,
      ok: true,
    };
  } finally {
    await owner.close();
  }
}

async function benchmarkPort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = await getFreePort();
    if (port >= 40000) {
      return port;
    }
  }
  throw new Error("Could not allocate a benchmark port >= 40000");
}

async function waitForBenchmarkStart() {
  if (!values["start-at"]) {
    return;
  }
  const startAt = parsePositiveInt(values["start-at"], 0, "start-at");
  if (startAt < Date.now()) {
    throw new Error("Missed --start-at before workload was ready");
  }
  await delay(startAt - Date.now());
}

function execToolResponse(turn: number) {
  const marker = EXEC_POLICY_MARKER;
  const item = {
    type: "function_call",
    id: `fc_exec_${turn}`,
    call_id: `call_exec_${turn}`,
    name: "exec",
    arguments: JSON.stringify({ command: `${realpathSync("/bin/echo")} ${marker}` }),
  };
  return {
    marker,
    events: [
      { type: "response.output_item.added", item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: item.arguments },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: `resp_exec_${turn}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
        },
      },
    ],
  };
}

let providerLogOffset = 0;
function assertExecToolCompleted(turn: number, marker: string) {
  const descriptor = openSync(path.join(output, "provider-requests.jsonl"), "r");
  let appended: Buffer;
  try {
    appended = Buffer.alloc(fstatSync(descriptor).size - providerLogOffset);
    let consumed = 0;
    while (consumed < appended.length) {
      const count = readSync(
        descriptor,
        appended,
        consumed,
        appended.length - consumed,
        providerLogOffset + consumed,
      );
      if (!count) {
        throw new Error("Provider request log ended before the completed turn");
      }
      consumed += count;
    }
    providerLogOffset += consumed;
  } finally {
    closeSync(descriptor);
  }
  const records = appended.toString("utf8").trim().split("\n");
  const expectedHash = createHash("sha256").update(marker.trim()).digest("hex");
  for (const record of records) {
    const logged = JSON.parse(record);
    for (const fact of logged.contentFacts ?? []) {
      if (
        fact.type === "function_call_output" &&
        fact.callId === `call_exec_${turn}` &&
        fact.outputSha256 === expectedHash
      ) {
        return;
      }
    }
  }
  throw new Error(`Missing successful exec tool output for turn ${turn}`);
}
type TurnIdentity = { phase: string; turnId: string };
type TurnEvidence = TurnIdentity & {
  key: string;
  messageId: string;
  firstOutboundMs: number;
  settledMs: number;
  result: { status: "ok" };
  outboundId: string;
  execToolVerified?: boolean;
};
function summarizeTurnLatency(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    ...summarizeNumbers(samples),
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
  };
}
const evidence: {
  output: string;
  harnessVersion: string;
  phases: { phase: string; start: number; end: number }[];
  turns: TurnEvidence[];
  children: { name: string; pid: number }[];
  ports?: { port: number; mockPort: number };
  ready?: unknown;
  shutdown?: [number | null, NodeJS.Signals | null];
  bus?: unknown;
  ok?: boolean;
  error?: string;
  execPolicyRules?: number;
  steady?: {
    completedTurns: number;
    warmupTurns: number;
    diagnostics: Awaited<ReturnType<Awaited<ReturnType<typeof startGatewayDiagnostics>>>>;
    firstOutboundMs: ReturnType<typeof summarizeTurnLatency>;
    settledMs: ReturnType<typeof summarizeTurnLatency>;
    allocations?: ReturnType<typeof readGatewayHeapProfile> & { allocatedMbPerTurn: number };
    gc?: ReturnType<typeof readGatewayGcTrace> & {
      promotedMbPerTurn: number;
      scavengeSecondsPerMinute: number;
      majorSecondsPerMinute: number;
    };
  };
} = {
  output,
  harnessVersion: "3.0.0-channel.2",
  execPolicyRules: ruleCount,
  phases: [],
  turns: [],
  children: [],
};
const children: ChildProcess[] = [];
const logDrains = new Map<string, Promise<void>>();
const traces: Record<string, TurnIdentity> = {};
const messages: Record<string, TurnIdentity> = {};
let phase = "01.boot";
let phaseStart = Date.now();
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
let gateway: ChildProcess | undefined;
let interrupted = false;
let cleanupPromise: Promise<void> | undefined;
function save() {
  writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    try {
      await Promise.all(
        children.map((child) => stopChild(child, { teardownGraceMs: 10000, killGraceMs: 2000 })),
      );
    } finally {
      await bus?.stop();
      evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
      save();
    }
  })());
}
function interrupt(signal: "SIGINT" | "SIGTERM") {
  if (interrupted) {
    return;
  }
  interrupted = true;
  evidence.ok = false;
  evidence.error = `Interrupted by ${signal}`;
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase.new"), phase);
  renameSync(path.join(output, "phase.new"), path.join(output, "phase"));
  console.log("PHASE", phase);
  save();
}
function launch(args: string[], env: NodeJS.ProcessEnv, name: string, ipc = false) {
  if (interrupted) {
    throw new Error("Benchmark interrupted");
  }
  const out = createWriteStream(path.join(output, name + ".log"));
  const err = createWriteStream(path.join(output, name + ".stderr.log"));
  logDrains.set(
    name,
    Promise.all([finished(out), finished(err)]).then(() => {}),
  );
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(err);
  children.push(child);
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn ${name}`);
  }
  evidence.children.push({ name, pid: child.pid });
  save();
  return child;
}
function publish(file: string, value: unknown) {
  const target = path.join(output, file);
  writeFileSync(target + ".new", JSON.stringify(value));
  renameSync(target + ".new", target);
}
writeFileSync(path.join(output, "phase"), phase);
console.log("OUTPUT", output);
try {
  const manifestPath = path.join(output, "prepared-fixture.json");
  const prepared:
    | {
        port: number;
        mockPort: number;
        busPort: number;
        ruleCount?: number;
      }
    | undefined = values["prepared-fixture"]
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : undefined;
  if (prepared && prepared.ruleCount !== ruleCount) {
    throw new Error("Prepared fixture policy size differs from --exec-policy-rules");
  }
  const port = prepared?.port ?? (await benchmarkPort());
  const mockPort = prepared?.mockPort ?? (await benchmarkPort());
  const busPort = prepared?.busPort ?? (await benchmarkPort());
  const configPath = path.join(fixture, "openclaw.json");
  if (!prepared) {
    const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
    cfg.tools = {
      codeMode: false,
      ...(ruleCount ? { exec: { host: "gateway", mode: "allowlist" } } : {}),
    };
    applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
    cfg.agents = {
      ...cfg.agents,
      defaults: { ...cfg.agents?.defaults, heartbeat: { every: "0m" }, skipBootstrap: true },
    };
    cfg.agents.entries = { main: { workspace: path.join(fixture, "workspace") } };
    mkdirSync(path.join(fixture, "workspace"));
    cfg.plugins = {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        "memory-core": { config: { dreaming: { enabled: false } } },
        "qa-channel": { enabled: true },
      },
    };
    cfg.channels = {
      "qa-channel": {
        enabled: true,
        baseUrl: `http://127.0.0.1:${busPort}`,
        allowFrom: ["*"],
        pollTimeoutMs: 100,
      },
    };
    writeGatewayBenchConfig(fixture, cfg, {});
    if (ruleCount) {
      const owner = await openExecPolicyFixture(path.join(fixture, "state"), ruleCount);
      await owner.close();
    }
    writeFileSync(manifestPath, JSON.stringify({ port, mockPort, busPort, ruleCount }));
  }
  if (values["prepare-only"]) {
    console.log("PREPARED", output);
    process.exit(0);
  }
  evidence.ports = { port, mockPort };
  const state = createQaBusState();
  bus = await startQaBusServer({ state, port: busPort });
  const control = path.join(output, "mock-control.json");
  publish("channel-turns.json", messages);
  publish("trace-map.json", traces);
  launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    {
      PATH: process.env.PATH,
      HOME: fixture,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: control,
      MOCK_REQUEST_LOG: path.join(output, "provider-requests.jsonl"),
      OPENCLAW_MOCK_OPENAI_REQUEST_LOG_BODY_MAX_BYTES: "4096",
    },
    "mock",
  );
  const mockReady = await waitForInitialProbe({
    port: mockPort,
    path: "/health",
    startAt: performance.now(),
    deadlineAt: performance.now() + 30000,
  });
  if (mockReady.status !== 200) {
    throw new Error("Mock provider not ready");
  }
  gateway = launch(
    buildGatewayBenchChildArgs(
      values.entry,
      port,
      steadyDurationMs
        ? [
            "--trace-gc-nvp",
            "--import",
            "./scripts/tsx.mjs",
            "--import",
            "./scripts/lib/gateway-bench-profile-preload.ts",
          ]
        : [],
    ),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      OPENAI_API_KEY: "synthetic-sqlmeasure-fixture",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: process.env.OPENCLAW_CHANNEL_BENCH_NODE_OPTIONS ?? "--enable-source-maps",
    },
    "gateway",
    steadyDurationMs > 0,
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300000,
    isDone: () => gateway != null && (gateway.exitCode !== null || gateway.signalCode !== null),
  });
  evidence.ready = ready;
  if (ready.status !== 200) {
    throw new Error("Gateway not ready");
  }
  await delay(1000);
  if (!steadyDurationMs) {
    await waitForBenchmarkStart();
  }
  let finishDiagnostics: Awaited<ReturnType<typeof startGatewayDiagnostics>> | undefined;
  const allocationPath = values.allocations ? path.join(output, "steady.heapprofile") : undefined;
  const samplingIntervalBytes = 512 * 1024;
  const warmupStarted = performance.now();
  let measuredTurnIndex = 0;
  let measuredStart = 0;
  for (let i = 0; ; i++) {
    if (i >= 11 && !measuredStart && performance.now() - warmupStarted >= warmupMs) {
      if (!steadyDurationMs) {
        break;
      }
      await waitForBenchmarkStart();
      if (allocationPath) {
        await controlGatewayProfile(gateway, "heap", "start", allocationPath, {
          samplingIntervalBytes,
        });
      } else {
        finishDiagnostics = await startGatewayDiagnostics(gateway, "channel-steady");
      }
      measuredTurnIndex = i;
      measuredStart = performance.now();
    }
    if (
      measuredStart &&
      i >= measuredTurnIndex + steadyTurns &&
      performance.now() - measuredStart >= steadyDurationMs
    ) {
      break;
    }
    setPhase(
      i === 0
        ? "02.first-turn"
        : `${measuredStart ? "04.measured" : "03.warm"}-${String(i).padStart(2, "0")}`,
    );
    const turnId = createHash("sha256").update(phase).digest("hex").slice(0, 32);
    const messageId = `sqlmeasure-${i}`;
    // Keep long captures comparable without compaction or unbounded provider history.
    const conversationId = steadyDurationMs
      ? `sqlmeasure-peer-${Math.floor(i / 20)}`
      : "sqlmeasure-peer";
    traces[turnId] = { phase, turnId };
    messages[messageId] = { phase, turnId };
    publish("trace-map.json", traces);
    publish("channel-turns.json", messages);
    const reply = `Synthetic channel measurement response ${i}. The Gateway receives this streamed answer from the local mock provider and delivers it to the isolated QA bus.`;
    const tool = ruleCount ? execToolResponse(i) : undefined;
    publish(
      "mock-control.json",
      tool
        ? {
            scriptVersion: `exec-turn-${i}`,
            responses: [{ events: tool.events }, { text: reply, chunkDelayMs: 5 }],
          }
        : { text: reply, chunkDelayMs: 5 },
    );
    const start = Date.now();
    const cursor = state.getSnapshot().cursor;
    const firstOutbound = state
      .waitForCursorAdvance(cursor, 180000, (snapshot) =>
        snapshot.messages.some(
          (message) => message.direction === "outbound" && message.replyToId === messageId,
        ),
      )
      .then(() => Date.now() - start);
    void firstOutbound.catch(() => {});
    state.addInboundMessage(
      {
        accountId: "default",
        conversation: { kind: "direct", id: conversationId },
        senderId: "sqlmeasure-user",
        senderName: "SQL measurement",
        text: `Please give a short synthetic status report for measurement turn ${i}.`,
        timestamp: 1800000000000 + i,
      },
      messageId,
    );
    const inboundCursor = state.getSnapshot().cursor;
    await state.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: reply,
      timeoutMs: 180000,
    });
    const firstOutboundMs = await firstOutbound;
    // The poll acknowledgement follows dispatch, preview cleanup and receipt settlement.
    const deadline = Date.now() + 180000;
    while (state.getAcknowledgedPollCursor("default") < inboundCursor) {
      if (gateway.exitCode !== null || gateway.signalCode !== null) {
        throw new Error("Gateway exited during turn");
      }
      if (Date.now() >= deadline) {
        throw new Error("Inbound dispatch did not settle");
      }
      await delay(50);
    }
    const settledMs = Date.now() - start;
    const result = state
      .getSnapshot()
      .messages.find(
        (message) =>
          message.direction === "outbound" &&
          message.replyToId === messageId &&
          message.text === reply &&
          !message.deleted &&
          !message.isError,
      );
    if (!result) {
      throw new Error("No durable outbound reply after dispatch settled");
    }
    if (tool) {
      assertExecToolCompleted(i, tool.marker);
    }
    evidence.turns.push({
      phase,
      key: `qa-channel:${conversationId}`,
      turnId,
      messageId,
      firstOutboundMs,
      settledMs,
      result: { status: "ok" },
      outboundId: result.id,
      ...(tool ? { execToolVerified: true } : {}),
    });
    save();
    if (i < 11) {
      await delay(1000);
    }
  }
  if (measuredStart) {
    if (allocationPath) {
      await controlGatewayProfile(gateway, "heap", "stop", allocationPath);
    }
    const allocations = allocationPath
      ? readGatewayHeapProfile(allocationPath, { samplingIntervalBytes })
      : undefined;
    const diagnostics = allocations?.diagnostics ?? (await finishDiagnostics?.());
    if (!diagnostics) {
      throw new Error("Gateway did not report steady-phase diagnostics");
    }
    const measuredTurns = evidence.turns.slice(measuredTurnIndex);
    evidence.steady = {
      completedTurns: measuredTurns.length,
      warmupTurns: measuredTurnIndex,
      diagnostics,
      firstOutboundMs: summarizeTurnLatency(measuredTurns.map((turn) => turn.firstOutboundMs)),
      settledMs: summarizeTurnLatency(measuredTurns.map((turn) => turn.settledMs)),
      ...(allocations
        ? {
            allocations: {
              ...allocations,
              allocatedMbPerTurn:
                allocations.sampledAllocatedBytes / 1_000_000 / measuredTurns.length,
            },
          }
        : {}),
    };
  }
  setPhase("08.shutdown");
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    gateway?.once("close", (code, signal) => resolve([code, signal]));
  });
  gateway.kill("SIGTERM");
  evidence.shutdown = await Promise.race<[number | null, NodeJS.Signals | null]>([
    closed,
    delay(120000, undefined, { ref: false }).then(() => {
      throw new Error("shutdown timeout");
    }),
  ]);
  await logDrains.get("gateway");
  if (evidence.steady) {
    const trace = readGatewayGcTrace(
      path.join(output, "gateway.log"),
      allocationPath ?? "channel-steady",
      allocationPath ? "heap" : "diagnostics",
    );
    const { completedTurns, diagnostics } = evidence.steady;
    evidence.steady.gc = {
      ...trace,
      promotedMbPerTurn: trace.promotedBytes / 1_000_000 / completedTurns,
      scavengeSecondsPerMinute:
        ((diagnostics.gc.minorDurationMs?.total ?? 0) * 60) / diagnostics.durationMs,
      majorSecondsPerMinute:
        ((diagnostics.gc.majorDurationMs?.total ?? 0) * 60) / diagnostics.durationMs,
    };
  }
  evidence.bus = state.getSnapshot();
  evidence.ok = evidence.turns.length >= 11 && evidence.shutdown[0] === 0;
  setPhase("done");
  console.log("COMPLETE", output, "ok=" + evidence.ok);
  if (!evidence.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  evidence.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
