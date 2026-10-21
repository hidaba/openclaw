import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import * as sessionObserverModel from "./session-observer-model.js";

it("drains an accepted observer digest before closing its database", async ({ signal }) => {
  const race = await createGatewayCloseRace("gateway-session-observer-close", signal);
  const { fixture, kernel } = race;
  const disposalEntered = new AbortController();
  let handling: Promise<void> | undefined;
  let persisting: Promise<boolean | null> | undefined;
  let removeClient: (() => void) | undefined;
  try {
    const context = kernel.resolvePluginGatewayContext();
    assert(context, "Gateway context");
    const observer = context.sessionObserver;
    assert(observer, "Session observer");
    const sessionKey = "agent:main:observer-close";
    const sessionId = "observer-close-session";
    const runId = "observer-close-run";
    const headline = "Accepted before shutdown";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, lifecycleRevision: "observer-close-generation", updatedAt: 1 },
    );
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const { client } = makeClient("observer-close-client", "operator", ["operator.read"]);
    kernel.clients.add(client);
    removeClient = () => void kernel.clients.delete(client);
    const subscription = context.subscribeSessionMessageEvents(client.connId, sessionKey, {
      provisional: true,
    });
    assert(subscription, "Observer subscription admitted for the active connection");
    subscription.commit();
    observer.setConnectionVisibility(client.connId, true);

    const persist = sessionObserverModel.defaultPersistDigest;
    let settledBeforeDatabaseClose = false;
    vi.spyOn(sessionObserverModel, "defaultPersistDigest").mockImplementation((params) => {
      if (params.sessionKey !== sessionKey) {
        return persist(params);
      }
      persisting = (async () => {
        await race.block();
        const result = await persist(params);
        settledBeforeDatabaseClose = agent.db.isOpen;
        return result;
      })();
      return persisting;
    });
    const event = {
      runId,
      sessionId,
      sessionKey,
      agentId: "main",
      seq: 1,
      ts: 1_000,
      stream: "item",
      data: { kind: "preamble", progressText: headline },
    };
    handling = observer.handleEventAsync(event);
    await race.waitForEntry(handling, "Observer skipped digest persistence");
    await withinTest(handling, signal);
    const dispose = observer.disposeAsync.bind(observer);
    vi.spyOn(observer, "disposeAsync").mockImplementation(() => {
      const pending = dispose();
      disposalEntered.abort();
      return pending;
    });
    await race.close(disposalEntered.signal, undefined, {
      reason: "session observer close regression",
    });
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(race.closed).toBe(false);
    expect(agent.db.isOpen).toBe(true);
    await expect(
      observer.handleEventAsync({
        ...event,
        seq: 2,
        data: { kind: "preamble", progressText: "Refused after shutdown" },
      }),
    ).rejects.toThrow("Session observer is closed");

    const accepted = await race.finish(persisting);
    expect(accepted).toBe(true);
    expect(settledBeforeDatabaseClose).toBe(true);
    expect(agent.db.isOpen).toBe(false);
    const [row] = readClosedDatabase(
      agent.path,
      "SELECT json_extract(entry_json, '$.observerDigest') AS digest FROM session_nodes WHERE session_key = ?",
      sessionKey,
    );
    expect(JSON.parse(String(row?.digest))).toMatchObject({ headline, runId, revision: 1 });
  } finally {
    race.onCleanup(async () => {
      await Promise.allSettled([handling, persisting]);
      vi.restoreAllMocks();
      removeClient?.();
    });
    await race.dispose();
  }
});
