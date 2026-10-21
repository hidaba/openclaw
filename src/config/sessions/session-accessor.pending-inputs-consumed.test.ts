import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { bindUserTurnTranscriptAnnotation } from "../../sessions/user-turn-transcript-annotation.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  readSessionSubmittedInput,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  readSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { createPendingInputFixture } from "./session-accessor.pending.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionPendingInputReceiptsInWorker as listSessionPendingInputReceipts } from "./session-pending-input-receipts.js";
import { deriveTranscriptPredicateFields } from "./transcript-predicate-fields.js";

const {
  fixture,
  scope,
  options,
  database,
  message,
  request,
  stage,
  finish,
  close,
  restart,
  receipts,
} = createPendingInputFixture(
  "pending-input-consumed-release-",
  "agent:main:consumed-release",
  "consumed-session",
  "Synthetic accepted input",
  1,
);
const query = (sql: string) => database().db.prepare(sql);
const rows = (sql: string) => query(sql).all();
const pending = () => listSessionPendingInputs(scope());
const readTranscript = () => loadTranscriptEvents(scope());
const submitted = (id: string) => readSessionSubmittedInput(scope(), `${id}:user`);
const sourceReceipts = (runIds: string[], target = scope()) =>
  listSessionPendingInputReceipts(target, { runIds });
const pendingRows = (fields: string) =>
  rows(`SELECT ${fields} FROM session_pending_inputs ORDER BY seq`);
const internalMessage = (
  id: string,
  sourceTool: string,
  sourceSessionKey?: string,
  sourceChannel?: string,
) => ({
  ...message(id),
  provenance: {
    kind: "inter_session" as const,
    sourceTool,
    ...(sourceSessionKey ? { sourceSessionKey } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
  },
});
const settleMessage = (id: string) => internalMessage(id, "subagent_settle", "child-b", "internal");
const prepare = async (collected: boolean) => {
  const first = await stage("first");
  const sources = [first];
  if (!collected) {
    return { receipt: first, sources };
  }
  sources.push(await stage("second"));
  return { receipt: collect(sources, message("aggregate")), sources };
};
const promoteSync = (receipt: SessionPendingInputReceipt) =>
  expect(
    receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
  ).toMatchObject({ ok: true, value: { appended: true } });
const promote = (receipt: SessionPendingInputReceipt) => receipt.run(() => append(receipt));

const complete = (
  receipt: SessionPendingInputReceipt,
  outcome: Parameters<typeof buildAgentRunTerminalOutcome>[0],
) => receipt.completeAsync!(buildAgentRunTerminalOutcome(outcome));
const expectStates = (inputs: SessionPendingInputReceipt[], state: string) =>
  expect(inputs.map((input) => input.state)).toEqual(inputs.map(() => state));
const append = (receipt: SessionPendingInputReceipt) =>
  appendTranscriptMessage(scope(), { message: receipt.message });
const collect = (
  sources: SessionPendingInputReceipt[],
  collectedMessage: PersistedUserTurnMessage,
) => {
  const receipt = expectDefined(
    bindSessionPendingInputSources(sources, collectedMessage),
    "Expected collected input custody",
  );
  receipts.push(receipt);
  return receipt;
};

beforeEach(async () => {
  await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
});

it.each([
  { collected: false, observerFails: false },
  { collected: true, observerFails: true },
])(
  "releases custody without a writer lock ($collected, $observerFails)",
  async ({ collected, observerFails }) => {
    const { receipt, sources } = await prepare(collected);
    expectStates([receipt, ...sources], "queued");
    if (observerFails) {
      setLoggerOverride({ level: "silent", consoleLevel: "error" });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => {
        errorLog.mockRestore();
        resetLogger();
      });
      expect(() =>
        runOpenClawAgentWriteTransaction((current) => {
          deferOpenClawAgentPostCommitPublication(current, () => {
            throw new Error("postcommit observer failed");
          });
          promoteSync(receipt);
        }, options()),
      ).not.toThrow();
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("SQLite post-commit notification failed"),
      );
    } else {
      expect(await promote(receipt)).toMatchObject({ appended: true });
    }
    expectStates([receipt, ...sources], "consumed");
    expect(receipt.run(() => true)).toBe(true);
    const primary = database();
    const foreign = new DatabaseSync(primary.path);
    try {
      foreign.exec("BEGIN IMMEDIATE");
      runWithSqliteBusyTimeout(requireNativeSqliteDatabase(primary.db), 1, () => {
        expect(() => receipt.finish("cancelled")).not.toThrow();
        for (const source of sources) {
          expect(() => source.run(() => {})).toThrow("ownership ended");
        }
        expect(foreign.isTransaction).toBe(true);
        expect(() => primary.db.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
      });
    } finally {
      if (primary.db.isTransaction) {
        primary.db.exec("ROLLBACK");
      }
      if (foreign.isTransaction) {
        foreign.exec("ROLLBACK");
      }
      foreign.close();
    }
    expect(pendingRows("state, consumed_event_id")).toEqual(
      collected ? sources.map(() => ({ state: "queued", consumed_event_id: receipt.inputId })) : [],
    );
  },
);

it("commits one collected message and retains exact source receipts across rewrite and restart", async () => {
  const { sessionKey } = scope();
  const clients = [
    { id: "cli", mode: "cli", displayName: "CLI" },
    { id: "openclaw-control-ui", mode: "webchat" },
  ] as const;
  const stageClient = (id: string, content: string, index: 0 | 1) =>
    stage(id, {
      message: {
        ...message(id, content),
        __openclaw: { transport: { clients: [clients[index]] } },
      },
    });
  const first = await stageClient("collect-a", "First approved input", 0);
  const second = await stageClient("collect-b", "Second approved input", 1);
  const aggregate = collect(
    [first, second],
    message("collect-c", "First approved input\nSecond approved input"),
  );
  expect((await pending()).total).toBe(2);
  const appended = await promote(aggregate);
  expect(appended).toMatchObject({ appended: true, messageId: aggregate.inputId });
  expect((await submitted("collect-c"))?.["__openclaw"]).toMatchObject({ transport: { clients } });
  expect(await pending()).toEqual({ items: [], total: 0 });
  expect(await readSessionPendingInput(scope(), first.inputId)).toBeUndefined();
  expect(await sourceReceipts(["collect-a", "collect-b", "unknown"])).toEqual([
    { runId: "collect-a", state: "consumed", consumedByEventId: aggregate.inputId },
    { runId: "collect-b", state: "consumed", consumedByEventId: aggregate.inputId },
  ]);
  await finish(aggregate, "cancelled");
  await replaceTranscriptEvents(scope(), []);
  await restart();
  expect(await submitted("collect-a")).toEqual(first.message);
  expect(await submitted("collect-b")).toEqual(second.message);
  const duplicate = await stage("collect-a", {
    message: { ...first.message, timestamp: 200 },
  });
  expect(duplicate).toMatchObject({
    state: "consumed",
    inputId: first.inputId,
    message: first.message,
  });
  expect(() => promote(duplicate)).toThrow("already been consumed");
  await expect(
    stage("collect-a", { message: message("collect-a", "Changed input") }),
  ).rejects.toThrow("conflicts");
  expect(await readTranscript()).toEqual([]);
  expect(await pending()).toEqual({ items: [], total: 0 });
  expect(pendingRows("input_id, message_json, consumed_event_id")).toEqual(
    [first, second].map((source) => ({
      input_id: source.inputId,
      message_json: JSON.stringify(source.message),
      consumed_event_id: aggregate.inputId,
    })),
  );
  expect(await sourceReceipts(["collect-a"], { ...scope(), sessionId: "other" })).toEqual([]);
  await deleteSessionEntryLifecycle({
    archiveTranscript: false,
    storePath: fixture.storePath(),
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  });
  expect(query("SELECT count(*) AS n FROM session_pending_inputs").get()).toEqual({ n: 0 });
});

it.each(["empty-metadata", "transport-metadata", "changed-payload", "changed-sender"] as const)(
  "preserves legacy consumed input identity with %s",
  async (scenario) => {
    const empty = scenario === "empty-metadata";
    const originalTransport = empty ? {} : { channel: "test", messageId: "original-message" };
    const original: PersistedUserTurnMessage = {
      ...message("legacy-client"),
      provenance: { kind: "external_user", sourceTool: "original-source" },
      ...(empty
        ? {}
        : { __openclaw: { senderId: "original-sender", transport: originalTransport } }),
    };
    const source = await stage("legacy-client", { message: original });
    const aggregate = collect([source], message("legacy-collector"));
    await promote(aggregate);
    await finish(aggregate);
    const stored = () => rows("SELECT request_hash, message_json FROM session_pending_inputs");
    const before = stored();
    const retry: PersistedUserTurnMessage = {
      ...original,
      ...(scenario === "changed-payload" ? { content: "Changed input" } : {}),
      __openclaw: {
        ...original["__openclaw"],
        ...(scenario === "changed-sender" ? { senderId: "different-sender" } : {}),
        requesterOrigin: {
          sessionKey: scope().sessionKey,
          messageProvider: "telegram",
          senderId: "original-sender",
        },
        transport: {
          ...originalTransport,
          clients: [{ id: "cli", mode: "cli" }],
        },
      },
    };
    const replay = stage("legacy-client", { message: retry, requestFingerprint: "upgraded" });
    if (scenario.startsWith("changed-")) {
      await expect(replay).rejects.toThrow("conflicts with the accepted input");
    } else {
      const receipt = await replay;
      expect(receipt).toMatchObject({ state: "consumed", message: original });
      expect(() => receipt.run(() => {})).toThrow("already been consumed");
    }
    expect(stored()).toEqual(before);
    expect(await submitted("legacy-client")).toEqual(original);
  },
);

const stagePrivate = (assertCurrent = () => {}) =>
  stage("announce:private-child", {
    trackCompletion: true,
    assertCurrent,
    message: {
      ...internalMessage("announce:private-child", "subagent_announce"),
      content: "private child marker",
      display: false,
    },
  });
const completionRows = () => rows("SELECT * FROM session_input_completions");
const pendingCount = () =>
  query("SELECT COUNT(*) AS count FROM session_pending_inputs").get()?.count;
const transcriptRows = () =>
  rows("SELECT seq, event_json, created_at FROM transcript_events ORDER BY seq");
const snapshot = () => ({ completions: completionRows(), transcript: transcriptRows() });

it("retains collected source correlation when private completion commits", async () => {
  const source = await stagePrivate();
  const aggregate = collect([source], message("private-aggregate"));
  await expect(promote(aggregate)).resolves.toMatchObject({
    appended: true,
    messageId: aggregate.inputId,
  });
  const consumed = [
    {
      runId: "announce:private-child",
      state: "consumed",
      consumedByEventId: aggregate.inputId,
    },
  ];
  const readReceipts = () => sourceReceipts(["announce:private-child"]);
  expect(await readReceipts(), "collected source after transcript promotion").toEqual(consumed);
  const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
  await expect(source.completeAsync!(outcome)).resolves.toEqual(outcome);
  expect(await readReceipts(), "collected source after private completion").toEqual(consumed);
  await restart();
  const replay = await stagePrivate();
  expect(replay.completion).toEqual(outcome);
  expect(() => replay.run(() => "duplicate private work")).toThrow("already completed");
  expect(await readReceipts(), "collected source after database reopen").toEqual(consumed);
});

it("replays a shipped settle source against its prepared transcript", async () => {
  const runId = "announce:settle-cohort";
  const original = { ...settleMessage(runId), display: false as const };
  const prepareMessageAfterIdempotencyCheck = (candidate: PersistedUserTurnMessage) => ({
    ...candidate,
    content: "Approved synthetic input",
  });
  const first = await stage(runId, {
    message: original,
    trackCompletion: true,
    prepareMessageAfterIdempotencyCheck,
  });
  const originalHash = query("SELECT request_hash FROM session_pending_inputs").get()?.request_hash;
  promoteSync(first);
  expect(pendingCount()).toBe(0);
  expect(completionRows()).toEqual([]);
  await finish(first);
  const acceptedOrder = () => pendingRows("seq, input_id, request_hash, message_json, accepted_at");
  const beforeReplay = acceptedOrder();
  const beforeTranscript = transcriptRows();
  await restart();
  const receipt = await stage(runId, {
    message: { ...original, provenance: { ...original.provenance, sourceSessionKey: "child-a" } },
    trackCompletion: true,
    replaySourceSessionKeys: ["child-a", "child-b"],
    prepareMessageAfterIdempotencyCheck,
  });
  expect(acceptedOrder()).toEqual(beforeReplay);
  expect(receipt.message.provenance).toEqual(original.provenance);
  expect(receipt.completion).toBeUndefined();
  expect(receipt.run(() => "resumed")).toBe("resumed");
  await complete(receipt, { status: "ok" });
  expect(completionRows()).toMatchObject([{ request_hash: originalHash }]);
  expect(transcriptRows()).toEqual(beforeTranscript);
});

it.each([
  ["completed", "content", "conflicts with the accepted input"],
  ["completed", "sender", "conflicts with the accepted input"],
  ["completed", "tool", "requires an internal settle request"],
  ["completed", "run", "conflicts with the accepted input"],
  ["completed", "outside cohort", "conflicts with the accepted input"],
  ["completed", "session", undefined],
  ["completed", "authority", "source owner changed"],
  ["transcript", "content", "conflicts with the committed input"],
  ["transcript", "run", "conflicts with the accepted run"],
  ["transcript", "outside cohort", "committed source is outside the frozen settle cohort"],
  ["transcript", "authority after prepare", "source owner changed"],
  ["transcript", "malformed", "invalid persisted user message"],
] as const)("does not substitute a settle %s when %s differs", async (state, difference, error) => {
  const runId = "announce:guarded-settle";
  const original = {
    ...settleMessage(runId),
    __openclaw: { senderIsOwner: false, senderId: "original" },
  };
  const first = await stage(runId, { message: original, trackCompletion: true });
  if (state === "transcript") {
    promoteSync(first);
    if (difference === "malformed") {
      query(
        "UPDATE transcript_events SET event_json = json_set(event_json, '$.message.role', 'assistant'), message_role = ? WHERE json_extract(event_json, '$.message.idempotencyKey') = ?",
      ).run(
        deriveTranscriptPredicateFields('{"message":{"role":"assistant"}}').message_role,
        `${runId}:user`,
      );
    }
  } else {
    await complete(first, { status: "ok" });
  }
  await finish(first);
  const before = snapshot();
  if (difference === "session") {
    await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
  }
  let current = true;
  const replay = request(difference === "run" ? "announce:other-run" : runId, {
    trackCompletion: true,
    replaySourceSessionKeys: difference === "outside cohort" ? ["child-a"] : ["child-a", "child-b"],
    assertCurrent: () => {
      if (difference === "authority" || !current) {
        throw new Error("source owner changed");
      }
    },
    prepareMessageAfterIdempotencyCheck: (candidate) => {
      if (difference === "authority after prepare") {
        current = false;
      }
      return candidate;
    },
    message: {
      ...original,
      ...(difference === "content" ? { content: "different result" } : {}),
      ...(difference === "sender"
        ? { __openclaw: { senderIsOwner: false, senderId: "other" } }
        : {}),
      provenance: {
        ...original.provenance,
        sourceSessionKey: "child-a",
        ...(difference === "tool" ? { sourceTool: "sessions_send" } : {}),
      },
    },
  });
  if (error === undefined) {
    await expect(replay).resolves.toBeUndefined();
  } else {
    await expect(replay).rejects.toThrow(error);
  }
  expect(snapshot()).toEqual(before);
});

it.each(["missing", "outside cohort", "wrong tool"] as const)(
  "rejects a committed %s source before lossy preparation",
  async (source) => {
    const runId = "announce:lossy-settle";
    const incoming = internalMessage(runId, "subagent_settle", "child-b");
    const committedProvenance =
      source === "missing"
        ? undefined
        : {
            ...incoming.provenance,
            sourceTool: source === "wrong tool" ? "sessions_send" : "subagent_settle",
            sourceSessionKey: source === "outside cohort" ? "child-outside" : "child-b",
          };
    const lossyPrepare = (candidate: PersistedUserTurnMessage): PersistedUserTurnMessage => {
      const { provenance: _provenance, ...rest } = candidate;
      return { ...rest, ...(committedProvenance ? { provenance: committedProvenance } : {}) };
    };
    const first = await stage(runId, {
      message: incoming,
      trackCompletion: true,
      prepareMessageAfterIdempotencyCheck: lossyPrepare,
    });
    promoteSync(first);
    await finish(first);
    expect(pendingCount()).toBe(0);
    expect(completionRows()).toEqual([]);
    const before = transcriptRows();
    let preparations = 0;
    await expect(
      stage(runId, {
        message: incoming,
        trackCompletion: true,
        replaySourceSessionKeys: ["child-a", "child-b"],
        prepareMessageAfterIdempotencyCheck: (candidate) => {
          preparations += 1;
          return lossyPrepare(candidate);
        },
      }),
    ).rejects.toThrow("committed source is outside the frozen settle cohort");
    expect(preparations).toBe(0);
    expect(completionRows()).toEqual([]);
    expect(transcriptRows()).toEqual(before);
  },
);

it("opens a same-version store without completion tracking and installs it only on private use", async () => {
  const version = query("PRAGMA user_version").get();
  database().db.exec("DROP TABLE session_input_completions");
  await close();
  const hasCompletionTable = () =>
    Boolean(query("SELECT 1 FROM sqlite_schema WHERE name = 'session_input_completions'").get());
  expect(hasCompletionTable()).toBe(false);
  const ordinary = await stage("ordinary-without-feature");
  expect(hasCompletionTable()).toBe(false);
  await finish(ordinary, "cancelled");
  const privateInput = await stagePrivate();
  expect(hasCompletionTable()).toBe(true);
  expect(query("PRAGMA user_version").get()).toEqual(version);
  await finish(privateInput);
  await close();
  expect(hasCompletionTable()).toBe(true);
});

it("preserves a message-hook veto when retrying already committed private input", async () => {
  const first = await stagePrivate();
  promoteSync(first);
  await finish(first);
  const replay = await request("announce:private-child", {
    trackCompletion: true,
    message: first.message,
    prepareMessageAfterIdempotencyCheck: () => undefined,
  });
  expect(replay).toBeUndefined();
  expect(completionRows()).toEqual([]);
});

it("keeps a failed private receipt distinct from its successful retry", async () => {
  const first = await stagePrivate();
  await complete(first, { status: "error", error: "provider unavailable" });
  expect(completionRows()).toMatchObject([{ succeeded: 0 }]);
  await finish(first);
  const retry = await stagePrivate();
  expect(retry.completion).toBeUndefined();
  await complete(retry, { status: "ok" });
  expect(await complete(first, { status: "error" })).toMatchObject({
    error: "provider unavailable",
  });
  expect(pendingCount()).toBe(0);
  expect(completionRows()).toMatchObject([{ succeeded: 1 }]);
});

it.each(["pending", "interrupted", "consumed", "completed"] as const)(
  "reconciles saved peer delivery identity after restart (%s)",
  async (state) => {
    const runId = "peer-restart";
    const endpoint = (sessionKey: string, sessionId: string) => ({
      agentId: "main",
      sessionKey,
      sessionId,
      lifecycleRevision: undefined,
    });
    const original: PersistedUserTurnMessage = {
      ...internalMessage(runId, "sessions_send", "agent:main:source"),
      __openclaw: {
        sessionSendDelivery: {
          version: 1,
          runId,
          source: endpoint("agent:main:source", "source-id"),
          target: endpoint(scope().sessionKey, scope().sessionId),
          sandboxed: false,
          message: "Synthetic accepted input",
        },
      },
    };
    const first = await stage(runId, { message: original, trackCompletion: true });
    if (state === "consumed" || state === "completed") {
      await promote(first);
    }
    if (state !== "pending") {
      await complete(
        first,
        state === "completed" ? { status: "ok" } : { status: "error", stopReason: "restart" },
      );
    }
    await finish(first);
    await restart();

    const saved = expectDefined(
      await readSessionSubmittedInput(scope(), `${runId}:user`),
      "Expected saved peer input after restart",
    );
    // SQLite JSON omits undefined endpoint revisions; recovery must match the original hash.
    expect(JSON.stringify(saved)).not.toContain("lifecycleRevision");
    await expect(
      stage(runId, { message: { ...saved, content: "Different input" }, trackCompletion: true }),
    ).rejects.toThrow("conflicts");
    const recovered = await stage(runId, { message: saved, trackCompletion: true });
    expect(recovered.message).toEqual(saved);
    if (state === "completed") {
      expect(recovered.completion).toMatchObject({ reason: "completed" });
      expect(() => recovered.run(() => {})).toThrow("already completed");
    } else {
      expect(recovered.completion).toBeUndefined();
      await complete(recovered, { status: "ok" });
    }
  },
);

it.each(["owner", "session", "lifecycle"] as const)(
  "rejects a private completion after %s changes",
  async (boundary) => {
    let current = true;
    const first = await stagePrivate(() => {
      if (!current) {
        throw new Error("owner changed");
      }
    });
    if (boundary === "owner") {
      current = false;
    }
    if (boundary === "session") {
      await upsertSessionEntryCore(scope(), { sessionId: "replacement-parent", updatedAt: 2 });
    }
    if (boundary === "lifecycle") {
      rotateAgentEventLifecycleGeneration();
    }
    await expect(async () => complete(first, { status: "ok" })).rejects.toThrow();
    expect(completionRows()).toEqual([]);
  },
);

it.each([
  { collected: true, rollback: "outer" },
  { collected: false, rollback: "savepoint" },
])(
  "terminalizes rolled-back consumption ($collected, $rollback)",
  async ({ collected, rollback }) => {
    const { receipt, sources } = await prepare(collected);
    const consumeThenFail = () => {
      promoteSync(receipt);
      throw new Error("rollback after consumption");
    };
    const expectRollback = () =>
      expect(() => runOpenClawAgentWriteTransaction(consumeThenFail, options())).toThrow(
        "rollback after consumption",
      );
    if (rollback === "outer") {
      expectRollback();
    } else {
      runOpenClawAgentWriteTransaction(expectRollback, options());
    }
    expectStates([receipt, ...sources], "queued");
    await finish(receipt, "cancelled");
    expect(pendingRows("state, consumed_event_id")).toEqual(
      sources.map(() => ({ state: "cancelled", consumed_event_id: null })),
    );
  },
);

async function commitMirroredInput() {
  const runId = "announce:settle-workers";
  const target = { ...scope(), sessionKey: "agent:main:subagent:lead", sessionId: "lead-session" };
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    lifecycleRevision: "lead-lifecycle",
    activeWriterRunId: runId,
    updatedAt: 1,
  });
  const recorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Worker integration ready",
      display: false,
      idempotencyKey: `${runId}:user`,
      requesterOrigin: { operatorProfileId: "gateway-owner", sessionKey: target.sessionKey },
      provenance: {
        kind: "inter_session",
        sourceTool: "subagent_settle",
        sourceSessionKey: "worker-b",
      },
    },
    target: { ...target, sessionEntry: loadSessionEntry(target) },
    trackInputCompletion: true,
  });
  expect(await recorder.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
  await recorder.persistApproved();
  const original = structuredClone(
    expectDefined(recorder.getPersistedMessage?.(), "admitted input"),
  );
  const annotate = expectDefined(
    bindUserTurnTranscriptAnnotation({ recorder, target, runId, assertCurrent: () => {} }),
    "native annotation owner",
  );
  const upstreamUserText = "Native harness context\nWorker integration ready";
  await annotate({
    mirrorIdentity: "native-turn:prompt",
    mirrorOrigin: "codex-app-server",
    upstreamUserText,
    mirrorSourceFingerprint: createHash("sha256")
      .update(JSON.stringify({ role: "user", content: original.content, upstreamUserText }))
      .digest("hex")
      .slice(0, 32),
  });
  const committed = structuredClone(
    expectDefined(recorder.getPersistedMessage?.(), "native prompt"),
  );
  const transcript = await loadTranscriptEvents(target);
  recorder.finishPendingInput?.("interrupted");
  await closeOpenClawAgentDatabasesAsync();
  rotateAgentEventLifecycleGeneration();
  const replay = (input: PersistedUserTurnMessage = original) =>
    stage(
      runId,
      {
        message: input,
        trackCompletion: true,
        replaySourceSessionKeys: ["worker-a", "worker-b"],
      },
      target,
    );
  return { target, original, committed, transcript, replay };
}

it("replays a committed native prompt without duplicating the mirrored input", async () => {
  const { target, original, committed, transcript, replay } = await commitMirroredInput();
  const receipt = await replay({
    ...original,
    provenance: { ...original.provenance, kind: "inter_session", sourceSessionKey: "worker-a" },
  });
  expect(receipt.message).toEqual(committed);
  expect(receipt.run(() => "continued")).toBe("continued");
  const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
  await expect(receipt.completeAsync!(outcome)).resolves.toEqual(outcome);
  expect(await loadTranscriptEvents(target)).toEqual(transcript);
});

it("still rejects changed completion content and requester facts against a native prompt", async () => {
  const { target, original, transcript, replay } = await commitMirroredInput();
  const requesterOrigin = expectDefined(
    original["__openclaw"]?.requesterOrigin,
    "requester origin",
  );
  const changed: PersistedUserTurnMessage[] = [
    { ...original, content: "Different result" },
    {
      ...original,
      __openclaw: {
        ...original["__openclaw"],
        requesterOrigin: { ...requesterOrigin, operatorProfileId: "other" },
      },
    },
    { ...original, __openclaw: { ...original["__openclaw"], unexpected: "extra metadata" } },
  ];
  for (const input of changed) {
    await expect(replay(input)).rejects.toThrow(/conflicts|does not match/);
  }
  expect(await loadTranscriptEvents(target)).toEqual(transcript);
});

it("replays pre-normalization requester origins only against their complete accepted hash", async () => {
  const target = { ...scope(), sessionKey: "agent:main:origin-replay", sessionId: "origin-replay" };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  for (const completed of [false, true]) {
    const runId = `origin-replay-${completed}`;
    const origin = { sessionKey: target.sessionKey, operatorProfileId: "gateway-owner" };
    const original = buildPersistedUserTurnMessage({
      text: "Private worker result",
      display: false,
      idempotencyKey: `${runId}:user`,
      requesterOrigin: captureRequesterOrigin(origin),
    });
    const replay = (input = original) =>
      stage(runId, { message: input, trackCompletion: true }, target);
    // The old producer hashed these own properties before JSON storage omitted them.
    const first = await replay({
      ...original,
      __openclaw: {
        ...original["__openclaw"],
        requesterOrigin: {
          ...origin,
          messageProvider: undefined,
          accountId: undefined,
          chatType: undefined,
          conversationId: undefined,
          messageThreadId: undefined,
          groupId: undefined,
          groupChannel: undefined,
          groupSpace: undefined,
          senderId: undefined,
          senderName: undefined,
          senderUsername: undefined,
          senderE164: undefined,
        },
      },
    });
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    if (completed) {
      await first.completeAsync!(outcome);
    }
    await finish(first);
    await restart();
    await expect(replay({ ...original, content: "Changed worker result" })).rejects.toThrow(
      /conflicts with the accepted input/,
    );
    await expect(
      replay({
        ...original,
        __openclaw: {
          ...original["__openclaw"],
          requesterOrigin: { ...origin, operatorProfileId: "different-requester" },
        },
      }),
    ).rejects.toThrow(/conflicts with the accepted input/);
    const receipt = await replay();
    if (completed) {
      expect(receipt).toMatchObject({ state: "consumed", completion: outcome });
    } else {
      await expect(receipt.completeAsync!(outcome)).resolves.toEqual(outcome);
    }
    await finish(receipt);
  }
});
