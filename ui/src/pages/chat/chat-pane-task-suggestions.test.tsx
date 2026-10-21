/* @vitest-environment jsdom */

import { createSignal, flush, type Setter } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  AgentsListResult,
  ProjectsListResult,
  TaskSuggestion,
  TaskSuggestionsAcceptResult as AcceptResult,
  TaskSuggestionsListResult as ListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane as createChatPane,
} from "./chat-pane.test-support.ts";
import {
  ChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
  type TaskSuggestionStartMode,
} from "./components/chat-task-suggestions.tsx";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:current",
  agentId: "main",
  createdAt: 1,
};
const nextSuggestion = { ...suggestion, id: "task_next", title: "Next task" };

function createRequestPane(
  handler: GatewayRequestHandler,
  methods?: string[],
  configureClient?: (client: GatewayBrowserClient) => void,
) {
  const request = createGatewayRequestMock(handler);
  const client = createTestGatewayClient(request);
  configureClient?.(client);
  const result = createChatPane({ client, sessions: createSessionCapabilityFixture() });
  const snapshot = result.pane.context.gateway.snapshot;
  snapshot.hello = gatewayHelloForMethods(
    methods ?? [
      ...(snapshot.hello?.features?.methods ?? []),
      "taskSuggestions.accept",
      "taskSuggestions.dismiss",
    ],
  );
  result.pane.tasks.suggestions = [suggestion];
  return {
    ...result,
    ...createTray(result.pane),
    props: (connected = true) => result.pane.suggestionChatProps(connected, false, false),
    request,
    accept: (mode?: TaskSuggestionStartMode, task = suggestion) =>
      result.pane.resolveTaskSuggestion(task, "accept", mode),
    resolved: (resolution: "accepted" | "dismissed") =>
      result.pane.handleTaskSuggestionEvent({
        action: "resolved",
        taskId: suggestion.id,
        resolution,
      }),
  };
}

function createAcceptancePane(
  accept?: () => unknown,
  suggestions: TaskSuggestion[] = [],
  configureClient?: (client: GatewayBrowserClient) => void,
) {
  const accepted = createDeferred<AcceptResult>();
  const respond = accept ?? (() => accepted.promise);
  const result = createRequestPane(
    (method) =>
      method === "taskSuggestions.accept" ? respond() : Promise.resolve({ suggestions }),
    undefined,
    configureClient,
  );
  return { ...result, accepted };
}

const acceptedResult: AcceptResult = {
  taskId: suggestion.id,
  key: "agent:main:task",
};
const acceptCall = (mode: TaskSuggestionStartMode, cwd?: string) => [
  "taskSuggestions.accept",
  { taskId: suggestion.id, mode, ...(cwd ? { cwd } : {}) },
];

function createTray(pane: ReturnType<typeof createChatPane>["pane"]) {
  const container = document.createElement("div");
  let setView: Setter<ChatTaskSuggestionTrayProps> | undefined;
  const query: typeof container.querySelector = container.querySelector.bind(container);
  return {
    container,
    acceptance: () =>
      pane.suggestionChatProps(true, false, false).taskSuggestionAcceptance?.(suggestion.id),
    query,
    draw: (connected = true) => {
      const props = pane.suggestionChatProps(connected, false, false);
      if (!setView) {
        const [current, update] = createSignal(props);
        mountSolid(() => <ChatTaskSuggestionTray view={current()} />, { container });
        setView = update;
      } else {
        setView(props);
      }
      flush();
      return props;
    },
  };
}

const sourceRequired = new GatewayRequestError({
  code: "INVALID_REQUEST",
  message: "Checkout has no commits",
  details: { code: "TASK_WORKTREE_SOURCE_REQUIRED" },
});

function acceptCalls(request: ReturnType<typeof createGatewayRequestMock>) {
  return request.mock.calls.filter(([method]) => method === "taskSuggestions.accept");
}

it.each(["confirmed", "resolved", "session", "connection"] as const)(
  "reconciles a pending dismissal after %s",
  async (outcome) => {
    const dismissed = createDeferred<{ taskId: string; dismissed: boolean }>();
    const listed = createDeferred<ListResult>();
    let holdLists = outcome === "confirmed";
    let suggestions = [suggestion];
    const { pane, state, request, resolved } = createRequestPane((method) =>
      method === "taskSuggestions.dismiss"
        ? dismissed.promise
        : holdLists
          ? listed.promise
          : Promise.resolve({ suggestions }),
    );
    const oldList = outcome === "confirmed" ? pane.refreshTaskSuggestions() : undefined;
    const pending = pane.resolveTaskSuggestion(suggestion, "dismiss");
    expect(pane.tasks.suggestions).toEqual([]);
    await pane.resolveTaskSuggestion(suggestion, "dismiss");
    expect(
      request.mock.calls.filter(([method]) => method === "taskSuggestions.dismiss"),
    ).toHaveLength(1);
    if (outcome === "confirmed") {
      const pendingList = pane.refreshTaskSuggestions();
      holdLists = false;
      suggestions = [];
      dismissed.resolve({ taskId: suggestion.id, dismissed: true });
      await pending;
      listed.resolve({ suggestions: [suggestion] });
      await Promise.all([oldList, pendingList]);
      expect(pane.tasks.suggestions).toEqual([]);
    } else {
      let expected: TaskSuggestion[] = [];
      if (outcome === "resolved") {
        suggestions = [];
        resolved("dismissed");
      } else {
        if (outcome === "connection") {
          pane.connectionGeneration += 1;
        } else {
          state.sessionKey = "agent:main:other";
        }
        expected = [{ ...suggestion, id: "task_other", sessionKey: state.sessionKey }];
        pane.tasks.suggestions = expected;
      }
      dismissed.reject(new Error("Old dismissal failed"));
      await pending;
      expect(pane.tasks.suggestions).toEqual(expected);
      expect(state.chatError).toBeNull();
    }
  },
);

it("preserves refused-dismissal reconciliation when another dismissal succeeds", async () => {
  const firstDismiss = createDeferred<{ taskId: string; dismissed: boolean }>();
  const secondDismiss = createDeferred<{ taskId: string; dismissed: boolean }>();
  const oldList = createDeferred<ListResult>();
  let listCount = 0;
  let dismissCount = 0;
  const { pane } = createRequestPane((method) => {
    if (method === "taskSuggestions.dismiss") {
      dismissCount += 1;
      return dismissCount === 1 ? firstDismiss.promise : secondDismiss.promise;
    }
    listCount += 1;
    return listCount === 1 ? oldList.promise : Promise.resolve({ suggestions: [suggestion] });
  });
  pane.tasks.suggestions = [suggestion, nextSuggestion];
  const first = pane.resolveTaskSuggestion(suggestion, "dismiss");
  const second = pane.resolveTaskSuggestion(nextSuggestion, "dismiss");
  firstDismiss.resolve({ taskId: suggestion.id, dismissed: false });
  await first;
  secondDismiss.resolve({ taskId: nextSuggestion.id, dismissed: true });
  await second;
  oldList.resolve({ suggestions: [suggestion, nextSuggestion] });

  await vi.waitFor(() => expect(pane.tasks.suggestions).toEqual([suggestion]));
});

it("surfaces clipboard failure through the pane error path", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  const execCommand = vi.fn(() => false);
  const restore = (
    [
      [navigator, "clipboard", { writeText }],
      [document, "execCommand", execCommand],
    ] as const
  ).map(([target, key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    return () =>
      descriptor
        ? Object.defineProperty(target, key, descriptor)
        : Reflect.deleteProperty(target, key);
  });
  const { pane, state } = createRequestPane(() => undefined);

  try {
    await pane.copyTaskSuggestionPrompt(suggestion);
  } finally {
    // The fallback restores focus on the next turn; drain it before jsdom teardown.
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    restore.forEach((reset) => reset());
  }

  expect(writeText).toHaveBeenCalledWith(suggestion.prompt);
  expect(execCommand).toHaveBeenCalledWith("copy");
  const failure = "Couldn't copy the prompt to the clipboard";
  expect(state).toMatchObject({ lastError: failure, chatError: failure });
});

it("hides a launched task through early events and stale lists without changing sessions", async () => {
  const { pane, state, request, props, accept, resolved, accepted } = createAcceptancePane(
    undefined,
    [suggestion, nextSuggestion],
  );
  state.lastError = "History unavailable";
  state.chatError = "Chat send failed";
  const navigate = vi.fn();
  pane.onPaneSessionChange = navigate;
  pane.tasks.suggestions = [suggestion, nextSuggestion];

  const pending = accept();
  expect(props().taskSuggestions).toEqual([nextSuggestion]);
  resolved("accepted");
  await pane.refreshTaskSuggestions();
  expect(pane.tasks.suggestions).toEqual([nextSuggestion]);
  await accept();
  expect(acceptCalls(request)).toEqual([acceptCall("local")]);
  accepted.resolve(acceptedResult);
  await pending;
  await pane.refreshTaskSuggestions();
  expect(pane.tasks.suggestions).toEqual([nextSuggestion]);
  expect(props().taskSuggestions).toEqual([nextSuggestion]);
  expect(navigate).not.toHaveBeenCalled();
  expect(state).toMatchObject({ lastError: "History unavailable", chatError: "Chat send failed" });
  await accept();
  expect(acceptCalls(request)).toHaveLength(1);
});

it("recovers a worktree source on the same card without changing the prompt or launch mode", async () => {
  let attempts = 0;
  const { request, container, draw, query, acceptance, accept } = createRequestPane(
    async (method) => {
      if (method === "projects.list") {
        return {
          projects: [
            { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
          ],
        };
      }
      if (method === "taskSuggestions.accept") {
        if (++attempts === 1) {
          throw sourceRequired;
        }
        return { ...acceptedResult, key: "agent:main:recovered" };
      }
      return { suggestions: [suggestion] };
    },
    ["taskSuggestions.accept", "projects.list"],
  );
  await accept("worktree");
  await vi.waitFor(() => {
    draw();
    expect(query(".task-suggestion__repository-choice")).not.toBeNull();
  });
  draw();
  expect(container.textContent).toContain(suggestion.prompt);
  expect(container.textContent).toContain("Checkout has no commits");
  const input = () => query<HTMLInputElement>(".task-suggestion__repository-path")!;
  expect(input().value).toBe(suggestion.cwd);
  query<HTMLButtonElement>(".task-suggestion__repository-choice")!.click();
  draw();
  expect(input().value).toBe("/projects/app");
  expect(attempts).toBe(1);
  [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Cancel")!
    .click();
  draw();
  expect(query(".task-suggestion__repository-path")).toBeNull();
  expect(container.textContent).toContain(suggestion.prompt);
  query<HTMLButtonElement>(".task-suggestion__retry")!.click();
  draw();
  expect(input().value).toBe("/projects/app");
  input().value = "relative/path";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  draw();
  expect(query<HTMLButtonElement>(".task-suggestion__retry")!.disabled).toBe(true);
  input().value = "/projects/app";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  draw();
  query<HTMLButtonElement>(".task-suggestion__retry")!.click();
  await vi.waitFor(() => expect(acceptance()?.phase).toBe("started"));
  draw();
  expect(query(".task-suggestion")).toBeNull();
  expect(acceptCalls(request)).toEqual([
    acceptCall("worktree"),
    acceptCall("worktree", "/projects/app"),
  ]);
  expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
});

it("does not populate a recovery chooser from a retired connection", async () => {
  const projects = createDeferred<ProjectsListResult>();
  const { pane, acceptance, accept } = createRequestPane(
    (method) => (method === "projects.list" ? projects.promise : Promise.reject(sourceRequired)),
    ["taskSuggestions.accept", "projects.list"],
  );
  await accept("worktree");
  pane.connectionGeneration += 1;
  projects.resolve({
    projects: [
      { id: "stale", displayName: "Stale project", repoRoot: "/stale", source: "registered" },
    ],
  });
  await projects.promise;
  const outcome = acceptance();
  expect(outcome?.phase === "failed" && outcome.repository?.projects).toEqual([]);
});

it("keeps submitted content through reconnect and fences a late acceptance behind a same-task retry", async () => {
  const first = createDeferred<AcceptResult>();
  const retry = createDeferred<AcceptResult>();
  let attempts = 0;
  const { pane, state, request, props, accept } = createRequestPane((method) => {
    if (method === "agents.list") {
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      } satisfies AgentsListResult);
    }
    return method === "taskSuggestions.accept"
      ? ++attempts === 1
        ? first.promise
        : retry.promise
      : Promise.resolve({ suggestions: [] });
  });
  pane.context.gateway.snapshot.selfUser = { id: "operator-a", name: "Operator A" };
  state.loadAssistantIdentity = vi.fn(async () => {});
  const snapshot = pane.context.gateway.snapshot;
  const pending = accept("worktree");

  pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
  const disconnected = props(false);
  expect(disconnected.taskSuggestions).toEqual([suggestion]);
  expect(disconnected.taskSuggestionAcceptance?.(suggestion.id)).toMatchObject({
    phase: "failed",
    error: "Delivery unconfirmed",
  });
  expect(disconnected.canAcceptTaskSuggestions).toBe(false);
  await accept();
  expect(attempts).toBe(1);
  pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
  await pane.refreshTaskSuggestions();
  expect(props().taskSuggestions).toEqual([suggestion]);
  const retrying = accept();
  first.resolve({ ...acceptedResult, key: "agent:main:stale" });
  await pending;
  expect(props().taskSuggestions).toEqual([]);
  retry.resolve({ ...acceptedResult, key: "agent:main:recovered-task" });
  await retrying;
  expect(props().taskSuggestions).toEqual([]);
  expect(acceptCalls(request)).toEqual([acceptCall("worktree"), acceptCall("worktree")]);
  pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null, selfUser: null });
  expect(props(false).taskSuggestions).toEqual([]);

  pane.applyGatewaySnapshot({
    ...snapshot,
    selfUser: { id: "operator-b", name: "Operator B" },
  });
  expect(props().taskSuggestions).toEqual([]);
  expect(pane.tasks.suggestions).toEqual([]);
});

it.each([
  { taskId: "other-task", key: "agent:main:task" },
  { taskId: suggestion.id, key: " " },
])("restores an unconfirmed acceptance and retries the same task (%j)", async (result) => {
  const first = createDeferred<AcceptResult>();
  const retry = createDeferred<AcceptResult>();
  let attempts = 0;
  const { pane, state, request, accept } = createAcceptancePane(() =>
    ++attempts === 1 ? first.promise : retry.promise,
  );
  const pending = accept("worktree");
  expect(pane.tasks.suggestions).toEqual([]);
  first.resolve(result);
  await pending;
  await pane.refreshTaskSuggestions();
  expect(pane.tasks.suggestions).toEqual([suggestion]);
  const failure = state.lastError;
  expect(failure).toContain("Couldn't confirm");
  expect(state.chatError).toBe(failure);
  const retrying = accept();
  expect(pane.tasks.suggestions).toEqual([]);
  expect(state).toMatchObject({ lastError: failure, chatError: failure });
  await accept();
  expect(attempts).toBe(2);
  expect(acceptCalls(request)).toEqual([acceptCall("worktree"), acceptCall("worktree")]);
  retry.resolve(acceptedResult);
  await retrying;
  expect(pane.tasks.suggestions).toEqual([]);
  expect(state).toMatchObject({ lastError: null, chatError: null });
});

it.each([
  { field: "lastError", sameMessage: false, beforeRetry: false },
  { field: "chatError", sameMessage: false, beforeRetry: false },
  { field: "lastError", sameMessage: true, beforeRetry: true },
  { field: "chatError", sameMessage: true, beforeRetry: false },
  { field: "both", sameMessage: true, beforeRetry: false },
  { field: "task", sameMessage: true, beforeRetry: false },
] as const)(
  "preserves a newer error when a task retry succeeds (%j)",
  async ({ field, sameMessage, beforeRetry }) => {
    const retry = createDeferred<AcceptResult>();
    let attempts = 0;
    const { pane, state, accept } = createAcceptancePane(() =>
      ++attempts === 2 ? retry.promise : Promise.reject(new Error("Session creation failed")),
    );
    const other = { ...suggestion, id: "task_other" };
    if (field === "task") {
      pane.tasks.suggestions = [suggestion, other];
    }
    await accept();
    const message = sameMessage ? "Session creation failed" : "Chat send failed";
    const publishNewerError = () => {
      for (const target of ["lastError", "chatError"] as const) {
        if (field === "both" || field === target) {
          state[target] = message;
        }
      }
    };
    if (beforeRetry) {
      publishNewerError();
    }
    const pending = accept();
    if (field === "task") {
      await accept(undefined, other);
    } else if (!beforeRetry) {
      publishNewerError();
    }
    retry.resolve(acceptedResult);
    await pending;
    expect(pane.tasks.suggestions).toEqual(field === "task" ? [other] : []);
    expect(state).toMatchObject({
      lastError: field === "chatError" ? null : message,
      chatError: field === "lastError" ? null : message,
    });
  },
);

it.each(["hello", "client", "unknown"] as const)(
  "retires submitted suggestion content when Hello changes the %s recovery owner",
  async (source) => {
    let recoveryReady = source === "client";
    const { pane, request, props, accept, accepted } = createAcceptancePane(
      undefined,
      [],
      (client) =>
        Object.defineProperties(client, {
          recoveryScope: { get: () => (source === "unknown" ? "" : "principal-a") },
          recoveryScopeReady: { get: () => recoveryReady },
        }),
    );
    const snapshot = pane.context.gateway.snapshot;
    const hello = snapshot.hello!;
    snapshot.hello = {
      ...hello,
      auth: { ...hello.auth, recoveryScope: source === "hello" ? "principal-a" : undefined },
    };
    snapshot.selfUser = { id: "operator-a", name: "Operator A" };
    const pending = accept();
    recoveryReady = false;
    pane.applyGatewaySnapshot({
      ...snapshot,
      hello: { ...hello, auth: { ...hello.auth, recoveryScope: "principal-a" } },
    });
    expect(props().taskSuggestions).toEqual([]);
    pane.applyGatewaySnapshot({
      ...snapshot,
      hello: { ...hello, auth: { ...hello.auth, recoveryScope: "principal-b" } },
    });
    expect(props().taskSuggestions).toEqual([]);
    expect(props().taskSuggestionAcceptance?.(suggestion.id)).toBeUndefined();
    accepted.resolve({ ...acceptedResult, key: "agent:main:old-owner" });
    await pending;
    expect(pane.tasks.suggestions).toEqual([]);
    expect(props().taskSuggestionAcceptance?.(suggestion.id)).toBeUndefined();
    expect(acceptCalls(request)).toHaveLength(1);
  },
);

it.each(
  (["starting", "failed", "started"] as const).flatMap((phase) =>
    [true, false].map((initiallyKnown) => ({ phase, initiallyKnown })),
  ),
)(
  "retires a $phase suggestion after physical session replacement (initially known: $initiallyKnown)",
  async ({ phase, initiallyKnown }) => {
    const { pane, state, request, props, accept, accepted } = createAcceptancePane();
    state.currentSessionId = initiallyKnown ? "physical-original" : undefined;
    state.loadAssistantIdentity = vi.fn(async () => {});
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    const pending = accept();
    if (phase === "failed") {
      accepted.reject(new Error("Acceptance response unavailable"));
      await pending;
    } else if (phase === "started") {
      accepted.resolve(acceptedResult);
      await pending;
    }
    expect(props().taskSuggestions).toEqual(phase === "failed" ? [suggestion] : []);
    state.currentSessionId = "physical-original";
    const originalProps = props();
    expect(originalProps.taskSuggestions).toEqual(phase === "failed" ? [suggestion] : []);

    state.currentSessionId = "physical-replacement";
    expect(props().taskSuggestions).toEqual([]);
    expect(props().taskSuggestionAcceptance?.(suggestion.id)).toBeUndefined();
    pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot });
    await pane.refreshTaskSuggestions();
    expect(pane.tasks.suggestions).toEqual([]);
    // Retained handlers cannot revive a retired operation after reconciliation removes it.
    originalProps.onAcceptTaskSuggestion?.(suggestion, "local");
    expect(navigate).not.toHaveBeenCalled();
    expect(acceptCalls(request)).toHaveLength(1);
    if (phase === "starting") {
      accepted.resolve({ ...acceptedResult, key: "agent:main:late-task" });
      await pending;
    }
    state.currentSessionId = "physical-original";
    expect(props().taskSuggestions).toEqual([]);
    expect(pane.tasks.suggestions).toEqual([]);
  },
);

it.each(["accept", "list"] as const)(
  "drops a late %s response after a same-client reconnect",
  async (action) => {
    const response = createDeferred<AcceptResult | ListResult>();
    const { pane, accept } = createRequestPane(() => response.promise);
    pane.tasks.suggestions = action === "accept" ? [suggestion] : [];
    const pending = action === "accept" ? accept() : pane.refreshTaskSuggestions();
    pane.connectionGeneration += 1;
    response.resolve(
      action === "accept"
        ? { ...acceptedResult, key: "agent:main:stale" }
        : { suggestions: [suggestion] },
    );
    await pending;
    expect(pane.tasks.suggestions).toEqual(action === "accept" ? [suggestion] : []);
  },
);
