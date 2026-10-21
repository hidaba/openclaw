import { describe, expect, it } from "vitest";
import {
  clearPendingSubmit,
  clearPendingSubmitDraft,
  resolveTuiChatSubmitAdmission,
  tuiSessionActionBlockedMessage,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";

type State = { pendingSubmit: TuiPendingSubmit | null };
const sending = { phase: "sending", runId: "run-local", draftText: "hello" } as const;
const accepted = { ...sending, phase: "accepted", runId: "run-accepted" } as const;
const registered = { ...accepted, draftText: null };

describe("resolveTuiChatSubmitAdmission", () => {
  it.each([
    ["idle", true, null, "hello", { status: "allowed" }],
    ["disconnected", false, null, "hello", { status: "blocked", reason: "disconnected" }],
    ["sending", true, sending, "another", { status: "blocked", reason: "pending" }],
    ["stop accepted run", true, registered, "please stop", { status: "allowed" }],
  ] as const)(
    "resolves admission while %s",
    (_name, isConnected, pendingSubmit, message, expected) => {
      expect(
        resolveTuiChatSubmitAdmission({
          isConnected,
          pendingSubmit,
          message,
          activeChatRunId: null,
          historyLoaded: true,
          transition: { active: null, boundary: null, epoch: 0 },
          allowDuringPending: false,
        }),
      ).toEqual(expected);
    },
  );
});

describe("pending submit transitions", () => {
  it("keeps draft ownership while a submit is still sending", () => {
    const state: State = {
      pendingSubmit: { phase: "sending", runId: "run-sending", draftText: "hello" },
    };

    expect(clearPendingSubmitDraft(state, "run-sending")).toBe(false);
    expect(state.pendingSubmit?.draftText).toBe("hello");
  });

  it("clears only the run that owns the pending state", () => {
    const state: State = {
      pendingSubmit: { phase: "accepted", runId: "run-current", draftText: "hello" },
    };

    expect(clearPendingSubmit(state, "run-other")).toBe(false);
    expect(state.pendingSubmit?.runId).toBe("run-current");
  });
});

describe("tuiSessionActionBlockedMessage", () => {
  it("uses the connection message for the selected runtime", () => {
    expect(
      tuiSessionActionBlockedMessage({ status: "blocked", reason: "disconnected" }, false),
    ).toBe("not connected to gateway — message not sent");
    expect(
      tuiSessionActionBlockedMessage({ status: "blocked", reason: "disconnected" }, true),
    ).toBe("local runtime not ready — message not sent");
  });
});
