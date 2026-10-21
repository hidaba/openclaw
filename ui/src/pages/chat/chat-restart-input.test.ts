/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { listChatOutboxAttention } from "./chat-outbox-owner.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { UNCONFIRMED_CHAT_SEND_ERROR } from "./chat-send-support.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

const sessionKey = "agent:main:restart-input";
const sessionId = "restart-input-session";
const item: ChatQueueItem = {
  id: "browser-input",
  sendRunId: "accepted-input",
  sessionKey,
  text: "Continue after the update",
  createdAt: 100,
  sendAttempts: 1,
  sendState: "waiting-reconnect",
};
function makeRestartHost({
  requestHandlers = {},
  ...overrides
}: NonNullable<Parameters<typeof makeChatHost>[0]> = {}) {
  return makeChatHost({ sessionKey, currentSessionId: sessionId, ...overrides, requestHandlers });
}
type Host = ReturnType<typeof makeRestartHost>;
function history<T extends object>(overrides: T) {
  return {
    sessionId,
    messages: [],
    sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
    ...overrides,
  };
}
function admit(host: Host, queued: ChatQueueItem = item) {
  expect(
    admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), queued),
  ).toBe(true);
}
function attemptedInput(overrides: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return {
    ...item,
    sessionId,
    sendState: "unconfirmed",
    sendError: UNCONFIRMED_CHAT_SEND_ERROR,
    ...overrides,
  };
}
function expectNoSend(host: Host) {
  expect(requestCalls(host.request, "chat.send")).toEqual([]);
}
function pending(state: "queued" | "interrupted"): ChatPendingInputsPage {
  return {
    total: 1,
    items: [
      {
        id: "durable-input",
        runId: item.sendRunId,
        acceptedAt: 100,
        state,
        message: { role: "user", content: item.text },
      },
    ],
  };
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("accepted input restart handoff", () => {
  it("keeps local commands behind accepted input until transcript consumption", async () => {
    let consumed = false;
    const host = makeRestartHost({
      requestHandlers: {
        "chat.history": () =>
          history({
            pendingInputs: consumed ? { items: [], total: 0 } : pending("interrupted"),
            inputReceipts: [
              consumed
                ? { runId: item.sendRunId, state: "consumed", consumedByEventId: "saved-input" }
                : { runId: item.sendRunId, state: "pending" },
            ],
          }),
        "sessions.compact": { ok: true, compacted: true },
      },
    });
    for (const queued of [
      item,
      {
        id: "queued-compact",
        text: "/compact",
        localCommandName: "compact",
        createdAt: 200,
        sendAttempts: 0,
        sendState: "waiting-reconnect" as const,
      },
    ]) {
      admit(host, { ...queued, sessionId });
    }
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "sessions.compact")).toEqual([]);
    consumed = true;
    await resumeStoredChatOutboxes(host);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "sessions.compact")).toHaveLength(1);
    expectNoSend(host);
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it("retains expired server custody without blocking a later queued input", async () => {
    let known = false;
    const successor = {
      ...item,
      id: "later-browser-input",
      sendRunId: "later-input",
      text: "A new independent input",
      createdAt: 200,
      sendAttempts: 0,
      sendState: "waiting-reconnect" as const,
    };
    const host = makeRestartHost({
      requestHandlers: {
        "chat.history": () =>
          history({
            pendingInputs: known ? pending("interrupted") : { items: [], total: 0 },
            inputReceipts: known ? [{ runId: item.sendRunId, state: "pending" }] : [],
          }),
        "chat.send": { runId: successor.sendRunId, status: "started", messageSeq: 10 },
      },
    });
    for (const queued of [item, successor]) {
      admit(host, { ...queued, sessionId });
    }
    // Without a fresh receipt, an uncertain predecessor remains a FIFO barrier.
    await resumeStoredChatOutboxes(host);
    expectNoSend(host);
    known = true;
    await resumeStoredChatOutboxes(host);
    await resumeStoredChatOutboxes(host);
    expect(requestCalls(host.request, "chat.send")).toEqual([
      [
        "chat.send",
        expect.objectContaining({ idempotencyKey: successor.sendRunId }),
        expect.anything(),
      ],
    ]);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
      expect.objectContaining({
        id: item.id,
        text: item.text,
        sessionId,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
      }),
    ]);
  });

  it.each(
    (["foreground history", "background reconciliation"] as const).flatMap((delivery) =>
      (["consumed", "cancelled"] as const).map((outcome) => ({ delivery, outcome })),
    ),
  )(
    "retains exact custody via $delivery until its off-page $outcome receipt settles",
    async ({ delivery, outcome }) => {
      let settled = false;
      const visible = delivery === "foreground history";
      const host = makeRestartHost({
        sessionKey: visible ? sessionKey : "agent:main:another-conversation",
        currentSessionId: visible ? sessionId : "another-physical-session",
        requestHandlers: {
          "chat.history": () =>
            history({
              pendingInputs: settled ? { items: [], total: 21, nextBefore: 21 } : pending("queued"),
              inputReceipts: settled
                ? [
                    outcome === "cancelled"
                      ? { runId: item.sendRunId, state: "pending", cancelled: true }
                      : {
                          runId: item.sendRunId,
                          state: "consumed",
                          consumedByEventId: "canonical-input",
                        },
                  ]
                : [{ runId: item.sendRunId, state: "pending" }],
            }),
        },
      });
      admit(host, attemptedInput());
      expect(listChatOutboxAttention(host)).toHaveLength(1);
      if (visible) {
        await loadChatHistory(host);
      } else {
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
        id: item.id,
        text: item.text,
        sessionId,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
        sendState: "waiting-idle",
      });
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendError).toBeUndefined();
      expect(listChatOutboxAttention(host)).toEqual([]);
      expectNoSend(host);
      settled = true;
      if (visible) {
        await loadChatHistory(host);
      } else {
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(listChatOutboxAttention(host)).toEqual([]);
      expectNoSend(host);
    },
  );

  it.each(["unknown later", "storage unavailable"] as const)(
    "retains the same attempted payload and never blindly replays it when %s",
    async (condition) => {
      let known = true;
      const host = makeRestartHost({
        requestHandlers: {
          "chat.history": () =>
            history({
              pendingInputs: known ? pending("queued") : { items: [], total: 0 },
              inputReceipts: known ? [{ runId: item.sendRunId, state: "pending" }] : [],
            }),
        },
      });
      admit(host, attemptedInput());
      if (condition === "storage unavailable") {
        vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
          throw new Error("storage unavailable");
        });
      }
      await resumeStoredChatOutboxes(host);
      if (condition === "unknown later") {
        expect(listChatOutboxAttention(host)).toEqual([]);
        known = false;
        await resumeStoredChatOutboxes(host);
      }
      expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
        id: item.id,
        text: item.text,
        sendRunId: item.sendRunId,
        sendAttempts: 1,
        sendState: "unconfirmed",
      });
      expect(listChatOutboxAttention(host)).toHaveLength(1);
      expectNoSend(host);
    },
  );

  it("reconciles interrupted custody behind a newer page without resending", async () => {
    const older = pending("interrupted");
    const host = makeRestartHost({
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number }) =>
          history({
            pendingInputs:
              params.pendingBefore === 21
                ? older
                : {
                    total: 21,
                    items: Array.from({ length: 20 }, (_, index) => ({
                      id: `newer-${index}`,
                      runId: `newer-run-${index}`,
                      acceptedAt: 200 + index,
                      state: "queued",
                      message: { role: "user", content: `Newer input ${index}` },
                    })),
                    nextBefore: 21,
                  },
            inputReceipts: [{ runId: item.sendRunId, state: "pending" }],
          }),
        "chat.send": { runId: item.sendRunId, status: "started" },
      },
    });
    admit(host, { ...item, sessionId });
    await resumeStoredChatOutboxes(host);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 21 }),
      { timeoutMs: 30_000 },
    );
    expectNoSend(host);
  });
});
