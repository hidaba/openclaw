import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readPersistedAuthProfileStateRaw,
  writePersistedAuthProfileStateRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.test-support.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
} from "./archive-compression.js";
import { isSessionArchiveArtifactName } from "./artifacts.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  cleanupSessionLifecycleArtifactsCore,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
  type SessionAccessScope,
  type SessionTranscriptAccessScope,
  type SessionTranscriptReadScope,
} from "./session-accessor.js";
import { listSessionEntryRows, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { observeSessionMaintenanceCompletion } from "./session-accessor.sqlite-maintenance-completion.test-support.js";
import { observeSessionMaintenanceChanges } from "./session-accessor.sqlite-maintenance.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import type { SessionEntry } from "./types.js";

// Keep accessor conformance independent of any real openclaw.json on the machine.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import { getRuntimeConfig } from "../config.js";

type TestPaths = {
  sqlitePath: string;
  stateDir: string;
  tempDir: string;
};

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-accessor-conf-");

function createTestPaths(): TestPaths {
  const tempDir = sessionDirs.make();
  return {
    sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
    stateDir: path.join(tempDir, "state"),
    tempDir,
  };
}

function setMaintenance(
  maintenance: NonNullable<
    NonNullable<ReturnType<typeof getRuntimeConfig>["session"]>["maintenance"]
  >,
) {
  vi.mocked(getRuntimeConfig).mockReturnValue({ session: { maintenance } });
}

function seedEntry(scope: SessionAccessScope, entry: SessionEntry, skipMaintenance = true) {
  return patchSessionEntryCore(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
    skipMaintenance,
  });
}

function expectEntry(scope: SessionAccessScope, expected: Partial<SessionEntry>) {
  expect(loadSessionEntry(scope)).toMatchObject(expected);
}

async function expectTranscript(scope: SessionTranscriptReadScope, expected: unknown[]) {
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(expected);
}

function pauseEntryPatch(scope: SessionAccessScope, model: string) {
  const started = createDeferred();
  const release = createDeferred();
  const pendingPatch = patchSessionEntryCore(scope, async () => {
    started.resolve();
    await release.promise;
    return { model };
  });
  return { started: started.promise, release: release.resolve, pendingPatch };
}

const modelEntry = (sessionId: string, model: string, updatedAt = 10): SessionEntry => ({
  sessionId,
  model,
  updatedAt,
});

function appendTrajectory(storePath: string, sessionId: string, type: string) {
  appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, [
    {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: sessionId,
      source: "runtime",
      type,
      ts: "2026-07-09T00:00:00.000Z",
      seq: 1,
      sessionId,
    },
  ]);
}

function readArchive(file: string) {
  return readSessionArchiveContentSync(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const entryScope = (paths: TestPaths): SessionAccessScope => ({
  agentId: "main",
  env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
  sessionKey: "agent:main:main",
  storePath: paths.sqlitePath,
});
const transcriptScope = (
  paths: TestPaths,
  sessionId = "session-1",
): SessionTranscriptAccessScope => ({
  ...entryScope(paths),
  sessionId,
});

beforeEach(() => {
  vi.mocked(getRuntimeConfig).mockReturnValue({});
});

afterEach(() => {
  vi.mocked(getRuntimeConfig).mockReset();
});

describe("session accessor conformance", () => {
  let paths: TestPaths;
  let env: NodeJS.ProcessEnv;
  const storeScope = () => ({ agentId: "main", env, storePath: paths.sqlitePath });
  const scopeFor = (sessionKey: string): SessionAccessScope => ({ ...storeScope(), sessionKey });
  const databaseFor = () => openOpenClawAgentDatabase({ ...storeScope(), path: paths.sqlitePath });

  beforeEach(() => {
    paths = createTestPaths();
    env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync(paths.tempDir);
  });

  it("reads the exact timestamp without selecting or decoding cold snapshots", async () => {
    const scope = entryScope(paths);
    replaceSessionEntrySync(scope, {
      sessionId: "timestamp-target",
      updatedAt: 42,
      skillsSnapshot: { prompt: `TIMESTAMP_COLD_PAYLOAD_${"x".repeat(65_536)}`, skills: [] },
    });
    const reads = observeMainThreadReads();
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(readSessionUpdatedAtCore(scope)).toBe(42);
      const queries = reads.calls
        .flatMap((call) => call.mock.contexts)
        .map((statement) => (statement as StatementSync).sourceSQL)
        .filter((sql) => /from "session_nodes"/i.test(sql));
      expect(queries).toHaveLength(1);
      expect.soft(queries.some((sql) => sql.includes("session_entry_snapshots"))).toBe(false);
      expect(parse.mock.calls.some(([value]) => value.includes("TIMESTAMP_COLD_PAYLOAD_"))).toBe(
        false,
      );
    } finally {
      parse.mockRestore();
      reads.restore();
    }
  });

  it("conforms for lifecycle entry and transcript cleanup", async () => {
    const nowMs = Date.now();
    const oldTimestamp = nowMs - 600_000;
    const cleanupStorePath = path.join(
      paths.stateDir,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const scope = (key: string, sessionId = "") => ({
      ...entryScope(paths),
      sessionKey: `agent:main:${key}`,
      sessionId,
      storePath: cleanupStorePath,
    });
    const entries = [
      ["lifecycle-cleanup-missing", "missing-lifecycle", oldTimestamp, false],
      ["lifecycle-cleanup-removed", "removed-lifecycle", oldTimestamp, true],
      ["lifecycle-cleanup-fresh", "fresh-lifecycle", nowMs, true],
      ["telegram:group:lifecycle-cleanup-room", "kept-by-segment", oldTimestamp, false],
      ["regular", "referenced", oldTimestamp, true],
      ["orphan", "orphan-lifecycle", oldTimestamp, true],
    ] as const;
    for (const [key, sessionId, updatedAt, transcript] of entries) {
      if (key !== "orphan") {
        await replaceSessionEntry(scope(key), { sessionId, updatedAt });
      }
      if (transcript) {
        await appendTranscriptEvent(scope(key, sessionId), {
          id: `${sessionId}-event`,
          marker: "lifecycle-marker-run",
          timestamp: new Date(updatedAt).toISOString(),
          type: "metadata",
        });
      }
    }

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        env: entryScope(paths).env,
        storePath: cleanupStorePath,
        sessionKeySegmentPrefix: "lifecycle-cleanup-",
        transcriptContentMarker: "lifecycle-marker-",
        orphanTranscriptMinAgeMs: 300_000,
        nowMs,
      }),
    ).resolves.toEqual({ removedEntries: 2, archivedTranscriptArtifacts: 1 });

    expect(entries.slice(0, 5).map(([key]) => loadSessionEntry(scope(key))?.sessionId)).toEqual([
      undefined,
      undefined,
      "fresh-lifecycle",
      "kept-by-segment",
      "referenced",
    ]);
    expect(fs.existsSync(cleanupStorePath)).toBe(false);
    await expect(loadTranscriptEvents(scope("regular", "referenced"))).resolves.not.toEqual([]);
    await expectTranscript(scope("lifecycle-cleanup-removed", "removed-lifecycle"), []);
    const files = fs.readdirSync(path.dirname(cleanupStorePath));
    const removedArchive = files.find((file) =>
      file.startsWith("removed-lifecycle.jsonl.deleted."),
    );
    const orphanArchive = files.find((file) => file.startsWith("orphan-lifecycle.jsonl.deleted."));
    expect(removedArchive).toBeDefined();
    // Route-referenced orphan history is retained in SQLite, not archived.
    expect(orphanArchive).toBeUndefined();
    await expect(loadTranscriptEvents(scope("orphan", "orphan-lifecycle"))).resolves.not.toEqual(
      [],
    );
    expect(readArchive(path.join(path.dirname(cleanupStorePath), removedArchive ?? ""))).toEqual([
      expect.objectContaining({ id: "removed-lifecycle-event", marker: "lifecycle-marker-run" }),
    ]);
  });

  it.each(["canonical", "custom"] as const)(
    "maps %s JSON paths to the agent SQLite database",
    async (kind) => {
      const canonical = kind === "canonical";
      const storePath = canonical
        ? path.join(paths.stateDir, "agents", "voice", "sessions", "sessions.json")
        : path.join(paths.tempDir, "custom-sessions.json");
      const sqlitePath = canonical
        ? path.join(paths.stateDir, "agents", "voice", "agent", "openclaw-agent.sqlite")
        : path.join(paths.tempDir, "custom-sessions.voice.sqlite");
      const scope = {
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: canonical ? "agent:voice:voice:123" : "agent:voice:main",
        storePath,
      };
      await upsertSessionEntryCore(scope, modelEntry("session-1", "gpt-5.5"));
      expectEntry(
        { ...scope, agentId: "voice", storePath: sqlitePath },
        { model: "gpt-5.5", sessionId: "session-1" },
      );
      expect([fs.existsSync(sqlitePath), fs.existsSync(storePath)]).toEqual([true, false]);
      if (canonical) {
        expect(listSessionEntryRows({ env: scope.env, storePath: sqlitePath })).toEqual([
          expect.objectContaining({
            entry: expect.objectContaining({ sessionId: "session-1" }),
            sessionKey: "agent:voice:voice:123",
          }),
        ]);
        expect(() =>
          loadSessionEntry({ ...scope, agentId: "main", storePath: sqlitePath }),
        ).toThrow("belongs to agent voice; requested agent main");
      }
    },
  );

  it("uses the requested agent for custom sessions.json SQLite targets", async () => {
    const customStorePath = path.join(paths.tempDir, "custom-store", "sessions.json");
    const customSqlitePath = path.join(
      path.dirname(customStorePath),
      "openclaw-agent.support.sqlite",
    );
    const scope = {
      agentId: "support",
      env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
      sessionKey: "agent:support:main",
      storePath: customStorePath,
    };

    await upsertSessionEntryCore(scope, modelEntry("support-session", "gpt-5.5"));
    const runtimeTarget = await resolveSessionTranscriptRuntimeTarget({
      ...scope,
      sessionId: "support-session",
    });

    expectEntry(
      { ...scope, storePath: customSqlitePath },
      {
        model: "gpt-5.5",
        sessionId: "support-session",
      },
    );
    expect(fs.existsSync(customSqlitePath)).toBe(true);
    expect(runtimeTarget).toMatchObject({
      agentId: "support",
      sessionId: "support-session",
      sessionKey: scope.sessionKey,
      storePath: customStorePath,
    });
  });

  it("archives stale SQLite entries below the entry cap on ordinary writes", async () => {
    const scope = entryScope(paths);
    const staleScope = { ...scope, sessionKey: "agent:main:stale-under-cap" };
    const staleEntry = {
      model: "stale",
      sessionId: "stale-under-cap",
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };
    await seedEntry(staleScope, staleEntry);

    const maintained = observeSessionMaintenanceChanges(paths.sqlitePath, staleScope.sessionKey);
    await upsertSessionEntryCore(scope, modelEntry("fresh-session", "fresh", Date.now()));

    await maintained;
    expectEntry(staleScope, {
      ...staleEntry,
      archivedAt: expect.any(Number),
      archiveReason: "age-retention",
    });
    expectEntry(scope, { model: "fresh", sessionId: "fresh-session" });
  });

  it("allows auth and trajectory writers while a session updater is preparing", async () => {
    const agentDir = path.join(paths.tempDir, "agents", "main", "agent");
    const conventionalStorePath = path.join(
      paths.tempDir,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:shared-writers",
      storePath: conventionalStorePath,
    };
    await replaceSessionEntry(scope, modelEntry("shared-writers", "base"));

    const { started, release: releaseUpdater, pendingPatch } = pauseEntryPatch(scope, "patched");
    await started;
    writePersistedAuthProfileStateRaw({ selectedProfile: "test" }, agentDir);
    appendTrajectory(conventionalStorePath, "shared-writers", "test.shared-writers");
    releaseUpdater();

    await expect(pendingPatch).resolves.toMatchObject({ model: "patched" });
    expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual({ selectedProfile: "test" });
  });

  it("dedupes SQLite transcript identities inside the writer path", async () => {
    const scope = transcriptScope(paths, "session-dedupe");
    const event = { id: "event-dedupe", source: "conformance", type: "metadata" };

    await appendTranscriptEvent(scope, event);
    await appendTranscriptEvent(scope, {
      ...event,
      message: { role: "assistant", content: "duplicate" },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        appendTranscriptMessage(scope, {
          idempotencyLookup: "scan",
          message: { role: "assistant", content: "keyed", idempotencyKey: "keyed-once" },
        }),
      ),
    );

    expect(new Set(results.map((result) => result?.messageId)).size).toBe(1);
    expect(results.filter((result) => result?.appended)).toHaveLength(1);
    await expectTranscript(scope, [
      event,
      expect.objectContaining({
        message: expect.objectContaining({ idempotencyKey: "keyed-once" }),
        parentId: null,
        type: "message",
      }),
    ]);
  });

  it("rejects raw message transcript event writes", async () => {
    const scope = transcriptScope(paths, "session-raw-message");
    await expect(
      appendTranscriptEvent(scope, {
        id: "raw-message",
        message: { role: "assistant", content: "raw" },
        parentId: null,
        type: "message",
      }),
    ).rejects.toThrow(/use append(?:Sqlite)?TranscriptMessage instead/);
  });

  it("dedupes event-id replays and rejects conflicts", async () => {
    const scope = transcriptScope(paths, "session-replay");
    const eventId = "message-retry-event-id";
    const message = {
      role: "assistant",
      content: "first attempt",
    };
    const options = { eventId, message };
    const appended = await appendTranscriptMessage(scope, options);
    const replayed = await appendTranscriptMessage(scope, options);
    await expect(
      appendTranscriptMessage(scope, {
        ...options,
        message: { ...message, content: "retry attempt" },
      }),
    ).rejects.toThrow(/conflicts with the admitted message/u);

    expect(appended).toMatchObject({ appended: true, messageId: eventId });
    expect(replayed).toMatchObject({
      appended: false,
      message: expect.objectContaining(message),
      messageId: appended?.messageId,
    });
    await expectTranscript(scope, [
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        id: appended?.messageId,
        message: expect.objectContaining(message),
        type: "message",
      }),
    ]);
  });

  it("conforms for transcript message append, idempotency, and update publication", async () => {
    const scope = transcriptScope(paths, "session-2");
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      updates.push(update);
    });
    onTestFinished(unsubscribe);

    const options = {
      cwd: paths.tempDir,
      idempotencyLookup: "scan" as const,
      message: { role: "assistant", content: "hello", idempotencyKey: "assistant-once" },
    };
    const appended = await appendTranscriptMessage(scope, options);
    const replayed = await appendTranscriptMessage(scope, options);
    await publishTranscriptUpdate(scope, {
      agentId: "main",
      message: appended?.message,
      messageId: appended?.messageId,
      sessionKey: scope.sessionKey,
    });
    unsubscribe();

    expect(appended).toMatchObject({
      anchor: {
        entryId: expect.any(String),
        agentId: "main",
        activeMessagePosition: expect.any(Number),
        effectiveParentId: null,
        generation: expect.any(String),
        idempotencyKey: "assistant-once",
        rawSeq: expect.any(Number),
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        storePath: expect.stringContaining("openclaw-agent.sqlite"),
      },
      appended: true,
      message: expect.objectContaining({ content: "hello" }),
      messageId: expect.any(String),
    });
    expect(replayed).toMatchObject({
      anchor: appended?.anchor,
      appended: false,
      message: expect.objectContaining({ content: "hello", idempotencyKey: "assistant-once" }),
      messageId: appended?.messageId,
    });
    await expect(
      appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: "conflicting replay",
          idempotencyKey: "assistant-once",
        },
      }),
    ).rejects.toThrow(/conflicts with the admitted message/u);
    await expectTranscript(scope, [
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        id: appended?.messageId,
        message: expect.objectContaining({ content: "hello" }),
        type: "message",
      }),
    ]);
    expect(updates).toEqual([
      expect.objectContaining({
        agentId: "main",
        message: appended?.message,
        messageId: appended?.messageId,
        sessionKey: scope.sessionKey,
      }),
    ]);
  });
  it("maintains normalized session node and window rows", async () => {
    await upsertSessionEntryCore(scopeFor("agent:main:group:example"), {
      agentHarnessId: "codex",
      chatType: "group",
      delivery: normalizeSessionDeliveryState({
        context: { accountId: "acct-1", channel: "discord", threadId: "thread-1", to: "group-1" },
      }),
      displayName: "Example group",
      endedAt: 90,
      model: "gpt-5.5",
      modelProvider: "openai",
      parentSessionKey: "agent:main:parent",
      sessionId: "normalized-session",
      sessionStartedAt: 50,
      spawnedBy: "agent:main:spawner",
      startedAt: 60,
      status: "done",
      updatedAt: 100,
    });

    const database = databaseFor();
    const session = database.db
      .prepare(`SELECT account_id, agent_harness_id, channel, chat_type,
      created_at, display_name, ended_at, model, model_provider, parent_session_key, session_key,
      session_scope, spawned_by, started_at, status, updated_at
      FROM session_windows WHERE session_id = ?`)
      .get("normalized-session");
    expect(session).toEqual({
      account_id: "acct-1",
      agent_harness_id: "codex",
      channel: "discord",
      chat_type: "group",
      created_at: 50,
      display_name: "Example group",
      ended_at: 90,
      model: "gpt-5.5",
      model_provider: "openai",
      parent_session_key: "agent:main:parent",
      session_key: "agent:main:group:example",
      session_scope: "group",
      spawned_by: "agent:main:spawner",
      started_at: 60,
      status: "done",
      updated_at: expect.any(Number),
    });

    const route = database.db
      .prepare("SELECT current_session_id, updated_at FROM session_nodes WHERE session_key = ?")
      .get("agent:main:group:example");
    expect(route).toEqual({
      current_session_id: "normalized-session",
      updated_at: expect.any(Number),
    });
  });

  it("writes a valid session beside an unrelated malformed legacy row", async () => {
    const database = databaseFor();
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run("agent:main:malformed", "malformed-session", "{ malformed", 0);

    await expect(
      replaceSessionEntry(scopeFor("agent:main:valid"), {
        sessionId: "valid-session",
        updatedAt: Date.now(),
      }),
    ).resolves.toMatchObject({ sessionId: "valid-session" });
    expect(
      database.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get("agent:main:malformed"),
    ).toEqual({ entry_json: "{ malformed" });
  });

  it("exposes same-key rollover lineage when a killed session is replaced", async () => {
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:29020";
    const oldSessionId = "f1321535-878b-47cd-b35e-2f5f4bae2bb5";
    const newSessionId = "c0daccb0-0555-47d8-8747-9b53addf1fe2";
    const scope = scopeFor(sessionKey);

    const stamp = {
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      chatType: "group" as const,
      displayName: "telegram:g-bucephalus-+-topics",
    };
    const creation = {
      createdVia: "channel" as const,
      createdActor: { type: "human" as const, source: "channel" as const, id: "telegram-sender" },
      createdAt: 1_782_973_390_000,
      forkSource: { sessionKey: "agent:main:main", sessionId: "root-session" },
    };
    await upsertSessionEntryCore(scope, {
      ...stamp,
      ...creation,
      sessionId: oldSessionId,
      status: "killed",
      updatedAt: 1_782_973_392_492,
    });
    await appendTranscriptEvent(
      { ...scope, sessionId: oldSessionId },
      { id: "old-frontier", payload: { label: "old transcript frontier" }, type: "metadata" },
    );

    await upsertSessionEntryCore(scope, {
      ...stamp,
      sessionId: newSessionId,
      status: undefined,
      updatedAt: 1_782_997_881_018,
    });
    await appendTranscriptEvent(
      { ...scope, sessionId: newSessionId },
      { id: "new-turn", payload: { label: "new active turn" }, type: "metadata" },
    );

    await expectTranscript({ ...scope, sessionId: oldSessionId }, [
      expect.objectContaining({ id: "old-frontier", type: "metadata" }),
    ]);
    await expectTranscript({ ...scope, sessionId: newSessionId }, [
      expect.objectContaining({ id: "new-turn", type: "metadata" }),
    ]);
    expect(loadSessionEntry(scope)).toEqual(
      expect.objectContaining({
        sessionId: newSessionId,
        ...creation,
        previousSessionId: oldSessionId,
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: [oldSessionId, newSessionId],
      }),
    );
  });

  it("keeps exact SQLite replacement entries free of inferred rollover lineage", async () => {
    const scope = scopeFor("agent:main:restore-exact");

    await upsertSessionEntryCore(scope, { sessionId: "temporary-session", updatedAt: 10 });
    await replaceSessionEntry(scope, { sessionId: "restored-session", updatedAt: 20 });

    expect(loadSessionEntry(scope)).toEqual({
      sessionId: "restored-session",
      updatedAt: 20,
      delivery: { kind: "none" },
    });
  });

  it("does not move current nodes back to stale transcript session ids", async () => {
    const scope = scopeFor("agent:main:main");
    await upsertSessionEntryCore(scope, { sessionId: "current-session", updatedAt: 20 });
    await appendTranscriptEvent(
      { ...scope, sessionId: "stale-session" },
      { id: "stale-event", timestamp: new Date(10).toISOString(), type: "metadata" },
    );

    const database = databaseFor();
    const route = database.db
      .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
      .get("agent:main:main");
    expect(route).toEqual({ current_session_id: "current-session" });
  });

  it("applies SQLite session-entry maintenance after entry writes", async () => {
    setMaintenance({ mode: "enforce", pruneAfter: "1d", maxEntries: 2 });
    const oldUpdatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;

    for (const [key, updatedAt] of [
      ["stale", oldUpdatedAt],
      ["older", oldUpdatedAt + 1],
      ["active", Date.now()],
    ] as const) {
      const entry = { sessionId: `${key}-session`, updatedAt };
      await seedEntry(scopeFor(`agent:main:${key === "active" ? key : `subagent:${key}`}`), entry);
    }
    const staleTranscriptEvent = {
      id: "stale-event",
      timestamp: new Date(oldUpdatedAt).toISOString(),
      type: "metadata",
    };
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:subagent:stale"), sessionId: "stale-session" },
      staleTranscriptEvent,
    );
    // A publisher's temporary file must not satisfy the archive-ready check.
    const pendingArchive = encodeSessionArchiveContent('{"id":"unpublished-event"}\n');
    fs.writeFileSync(
      path.join(
        paths.tempDir,
        `stale-session.jsonl.deleted.2026-09-02T00-00-00.000Z${pendingArchive.suffix}.f758980d-fd32-4cf1-8946-720e29457bfb.tmp`,
      ),
      pendingArchive.bytes,
    );

    await patchSessionEntryCore(scopeFor("agent:main:active"), () => ({ model: "gpt-5.5" }), {
      skipMaintenance: true,
    });
    await expectTranscript({ ...storeScope(), sessionId: "stale-session" }, [staleTranscriptEvent]);
    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:active",
      "agent:main:subagent:older",
      "agent:main:subagent:stale",
    ]);

    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    onTestFinished(unsubscribe);
    const maintained = observeSessionMaintenanceCompletion(paths.sqlitePath);
    await patchSessionEntryCore(scopeFor("agent:main:active"), () => ({
      providerOverride: "openai",
    }));
    await maintained;
    expect(new Set(notify.mock.calls.map(([mutation]) => mutation.previous.sessionId))).toEqual(
      new Set(["older-session", "stale-session"]),
    );
    const archivedStale = fs
      .readdirSync(paths.tempDir)
      .filter(
        (file) =>
          file.startsWith("stale-session.jsonl.deleted.") && isSessionArchiveArtifactName(file),
      );
    expect(archivedStale).toHaveLength(1);
    unsubscribe();
    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:active",
    ]);
    await expectTranscript({ ...storeScope(), sessionId: "stale-session" }, []);
    expect(readArchive(path.join(paths.tempDir, archivedStale[0] ?? ""))).toEqual([
      staleTranscriptEvent,
    ]);

    await seedEntry(scopeFor("agent:main:newer"), {
      sessionId: "newer-session",
      updatedAt: Date.now() + 1,
    });
    const capped = observeSessionMaintenanceChanges(paths.sqlitePath, "agent:main:active");
    await seedEntry(
      scopeFor("agent:main:newest"),
      { sessionId: "newest-session", updatedAt: Date.now() + 2 },
      false,
    );

    await capped;
    expect(listSessionEntryRows(storeScope()).map((summary) => summary.sessionKey)).toEqual([
      "agent:main:active",
      "agent:main:newer",
      "agent:main:newest",
    ]);
    expect(loadSessionEntry(scopeFor("agent:main:active"))?.archivedAt).toEqual(expect.any(Number));
  });

  it("persists automatic dashboard archiving before stale-entry pruning", async () => {
    setMaintenance({
      mode: "enforce",
      archiveDashboardAfter: "7d",
      pruneAfter: "30d",
      maxEntries: 500,
      maxDiskBytes: false,
    });
    const dashboardKey = "agent:main:dashboard:stale-visible-session";
    const dashboardSessionId = "stale-visible-session";
    const oldUpdatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const transcriptEvent = {
      id: "stale-visible-event",
      timestamp: new Date(oldUpdatedAt).toISOString(),
      type: "metadata",
    };

    await seedEntry(scopeFor(dashboardKey), {
      sessionId: dashboardSessionId,
      updatedAt: oldUpdatedAt,
    });
    await appendTranscriptEvent(
      { ...scopeFor(dashboardKey), sessionId: dashboardSessionId },
      transcriptEvent,
    );

    const maintained = observeSessionMaintenanceChanges(paths.sqlitePath, dashboardKey);
    await seedEntry(
      scopeFor("agent:main:explicit:maintenance-trigger"),
      { sessionId: "maintenance-trigger", updatedAt: Date.now() },
      false,
    );

    await maintained;
    expect(loadSessionEntry(scopeFor(dashboardKey))?.archivedAt).toEqual(expect.any(Number));
    await expectTranscript({ ...storeScope(), sessionId: dashboardSessionId }, [transcriptEvent]);
  });

  it.each([false, true])(
    "preserves protected transcripts during capping (pinned=%s)",
    async (pinned) => {
      setMaintenance({
        mode: "enforce",
        pruneAfter: "365d",
        maxEntries: 2,
        ...(pinned ? {} : { preserveRecent: "7d" }),
      });
      const now = Date.now();
      const protectedKey = "agent:main:protected-dashboard";
      const otherKey = "agent:main:other-dashboard";
      const event = {
        id: "protected-event",
        timestamp: new Date().toISOString(),
        type: "metadata",
      };
      const seed = (
        key: string,
        sessionId: string,
        updatedAt: number,
        extra: Partial<SessionEntry> = {},
      ) => seedEntry(scopeFor(key), { sessionId, updatedAt, ...extra });
      if (!pinned) {
        await seed("agent:main:archived-1", "archived-session-1", now - 4, { archivedAt: now - 4 });
      }
      await seed(
        protectedKey,
        "protected-session",
        pinned ? 1 : now - 2,
        pinned ? { pinnedAt: 2 } : {},
      );
      await appendTranscriptEvent(
        { ...scopeFor(protectedKey), sessionId: "protected-session" },
        event,
      );
      await seed(otherKey, "other-session", now - 1);
      const maintained = pinned
        ? observeSessionMaintenanceChanges(paths.sqlitePath, otherKey)
        : undefined;
      await seedEntry(
        scopeFor("agent:main:maintenance-trigger"),
        { sessionId: "trigger-session", updatedAt: now },
        false,
      );
      if (pinned) {
        await maintained;
        expectEntry(scopeFor(protectedKey), { pinnedAt: 2, sessionId: "protected-session" });
        expect(
          listSessionEntryRows(storeScope())
            .filter(({ entry }) => entry.archivedAt === undefined)
            .map(({ sessionKey }) => sessionKey),
        ).toEqual(["agent:main:maintenance-trigger", protectedKey]);
        expect(listSessionEntryRows(storeScope())).toHaveLength(3);
        expectEntry(scopeFor(otherKey), {
          sessionId: "other-session",
          archivedAt: expect.any(Number),
          archiveReason: "active-session-cap",
        });
      } else {
        expect(listSessionEntryRows(storeScope()).map(({ sessionKey }) => sessionKey)).toEqual([
          "agent:main:archived-1",
          "agent:main:maintenance-trigger",
          otherKey,
          protectedKey,
        ]);
      }
      await expectTranscript({ ...storeScope(), sessionId: "protected-session" }, [event]);
    },
  );

  it("keeps live entries and transcripts under byte pressure at save time", async () => {
    setMaintenance({
      highWaterBytes: 350,
      maxDiskBytes: 1_200,
      maxEntries: 100,
      mode: "enforce",
      pruneAfter: "365d",
    });
    const oldUpdatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (const [name, updatedAt, payload] of [
      ["unshared", oldUpdatedAt - 1_000, "😀".repeat(400)],
      ["old", oldUpdatedAt, "x".repeat(50)],
    ] as const) {
      const scope = {
        ...scopeFor(`agent:main:${name}-budget`),
        sessionId: `${name}-budget-session`,
      };
      await seedEntry(scope, { sessionId: scope.sessionId, updatedAt });
      await appendTranscriptEvent(scope, {
        id: `${name}-budget-event`,
        payload,
        timestamp: new Date(updatedAt).toISOString(),
        type: "metadata",
      });
    }
    await seedEntry(scopeFor("agent:main:active-budget"), {
      sessionId: "active-budget-session",
      updatedAt: Date.now(),
      usageFamilySessionIds: ["old-budget-session", "active-budget-session"],
    });

    await patchSessionEntryCore(scopeFor("agent:main:active-budget"), () => ({
      modelOverride: "gpt-5.5",
    }));

    // Live sessions are never save-time budget victims: byte pressure is
    // handled by the async physical-budget pass, which only reclaims
    // historical generations no entry, route, or admission references.
    expect(
      listSessionEntryRows(storeScope())
        .map((summary) => summary.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:active-budget", "agent:main:old-budget", "agent:main:unshared-budget"]);
    await expectTranscript({ ...storeScope(), sessionId: "old-budget-session" }, [
      expect.objectContaining({ id: "old-budget-event" }),
    ]);
    await expectTranscript({ ...storeScope(), sessionId: "unshared-budget-session" }, [
      expect.objectContaining({ id: "unshared-budget-event" }),
    ]);
    expect(
      fs.readdirSync(paths.tempDir).filter((file) => file.includes(".jsonl.deleted.")),
    ).toEqual([]);
  });

  it("fails loud for delivery-confirmed lowercased SQLite session aliases", async () => {
    const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const legacyKey = canonicalKey.toLowerCase();
    const canonicalError = `non-canonical persisted row resolves to session key ${canonicalKey}`;
    const entry = {
      delivery: normalizeSessionDeliveryState({
        context: { accountId: "acct-1", channel: "matrix", to: "!MixedCase:example.org" },
      }),
      sessionId: "legacy-alias-session",
      updatedAt: 10,
    };
    const database = databaseFor();
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(legacyKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt);
    // The entry identity is valid; admission must still reject its delivery-key alias.
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(legacyKey);

    expect(() => loadSessionEntry(scopeFor(canonicalKey))).toThrow(canonicalError);
    expect(() => listSessionEntryRows(storeScope())).toThrow(canonicalError);
    await expect(
      appendTranscriptEvent(
        { ...scopeFor(canonicalKey), sessionId: "canonical-transcript-session" },
        { id: "canonical-event", timestamp: new Date(20).toISOString(), type: "metadata" },
      ),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(() =>
      replaceSessionEntrySync(scopeFor(canonicalKey), { sessionId: "replacement", updatedAt: 20 }),
    ).toThrow("openclaw doctor --fix");
    expect(
      database.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(legacyKey),
    ).toEqual({ current_session_id: "legacy-alias-session" });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = -1 WHERE session_key = ?")
      .run("{ malformed", legacyKey);
    await expect(
      appendTranscriptEvent(
        { ...scopeFor(canonicalKey), sessionId: "canonical-transcript-session-2" },
        { id: "canonical-event-2", timestamp: new Date(21).toISOString(), type: "metadata" },
      ),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("fails loud for invalid imported rows instead of treating them as retained tombstones", () => {
    const sessionKey = "agent:main:invalid-live-row";
    const sessionId = "invalid-live-session";
    const database = databaseFor();
    markCanonicalSessionValidationPending(database, [sessionKey]);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run(sessionKey, sessionId, "{ malformed", 10);
    database.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, reason, created_at, updated_at) VALUES (?, ?, 'conversation', 'initial', 10, 10)",
      )
      .run(sessionId, sessionKey);

    expect(() => listSessionEntryRows(storeScope())).toThrow("openclaw doctor --fix");
  });

  it("fails loud when imported lineage disagrees with canonical entry JSON", async () => {
    const sessionKey = "agent:main:lineage-mismatch";
    const sessionId = "lineage-mismatch-session";
    const entry = { parentSessionKey: "agent:main:json-parent", sessionId, updatedAt: 10 };
    const database = databaseFor();
    markCanonicalSessionValidationPending(database, [sessionKey]);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionKey, sessionId, JSON.stringify(entry), 10, "agent:main:column-parent");
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sessionKey);

    await expect(
      listSessionChildEntriesReadOnly(scopeFor("agent:main:json-parent")),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(() => listSessionEntryRows(storeScope())).toThrow("openclaw doctor --fix");
  });

  it("normalizes missing entry updatedAt before writing root and entry rows", async () => {
    await replaceSessionEntry(scopeFor("agent:main:minimal"), {
      sessionId: "minimal-session",
      sessionStartedAt: 123,
    } as SessionEntry);

    const loaded = loadSessionEntry(scopeFor("agent:main:minimal"));
    expect(loaded).toMatchObject({
      sessionId: "minimal-session",
      sessionStartedAt: 123,
      updatedAt: 123,
    });

    const database = databaseFor();
    const row = database.db
      .prepare(`SELECT sw.created_at AS window_created_at,
      sw.updated_at AS window_updated_at, sn.entry_json, sn.updated_at AS node_updated_at
      FROM session_windows sw JOIN session_nodes sn ON sn.current_session_id = sw.session_id
      WHERE sw.session_id = ?`)
      .get("minimal-session");
    expect(row).toEqual({
      entry_json: JSON.stringify({
        sessionId: "minimal-session",
        sessionStartedAt: 123,
        delivery: { kind: "none" },
        updatedAt: 123,
      }),
      node_updated_at: 123,
      window_created_at: 123,
      window_updated_at: 123,
    });

    await upsertSessionEntryCore(scopeFor("agent:main:minimal-upsert"), {
      sessionId: "minimal-upsert-session",
    });
    const upsertRow = database.db
      .prepare("SELECT entry_json, updated_at FROM session_nodes WHERE session_key = ?")
      .get("agent:main:minimal-upsert");
    const upsertEntry = JSON.parse(String(upsertRow?.entry_json ?? "{}")) as Partial<SessionEntry>;
    expect(upsertEntry).toMatchObject({
      sessionId: "minimal-upsert-session",
      updatedAt: expect.any(Number),
    });
    expect(upsertRow?.updated_at).toBe(upsertEntry.updatedAt);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
