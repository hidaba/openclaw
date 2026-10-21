import "../config/sessions/session-entry-patch-delivery.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { getSession, waitForExecScope } from "../agents/bash-process-registry.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import {
  fullGatewayExec,
  nodeCommand,
  runningSession,
} from "../agents/bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "../agents/bash-tools.process.js";
import { acknowledgeInternalToolResult } from "../agents/runtime/internal-hooks.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { adoptUnboundPullRequestWorkspace } from "./session-pr-workspace-adoption.js";
import * as allocation from "./session-worktree-preparation.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");

it("adopts one empty owner and keeps original message files separate from same-name current files", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:adopt",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const entry = { sessionId: "adopt", updatedAt: 1, sessionRoot: state.workspaceDir };
    const sibling = { ...target, sessionKey: "agent:main:sibling" };
    await upsertSessionEntryCore(target, entry);
    await upsertSessionEntryCore(sibling, { ...entry, sessionId: "sibling" });
    const siblingBefore = loadSessionEntryReadOnly(sibling);
    const manager = await SessionManager.openAsync(
      { ...target, sessionId: entry.sessionId },
      state.workspaceDir,
    );
    const oldMessage = await manager.appendMessageAsync(makeUserMessage("Open notes.md", 1));
    const boundaryMessage = await manager.appendMessageAsync(makeUserMessage("Prepare my PR", 2));
    assert(oldMessage && boundaryMessage, "Original transcript messages must be persisted");
    await fs.writeFile(path.join(state.workspaceDir, "notes.md"), "same original bytes\n");
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const request = async (
      operation: "get" | "set" | "assets",
      params: Record<string, unknown> = {},
    ) => {
      const method = `sessions.files.${operation}`;
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: method,
          method,
          params: { sessionKey: target.sessionKey, path: "notes.md", ...params },
        },
        client: null,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionsFilesHandlers,
      });
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0]!;
    };
    const before = await request("get");
    expect(before[0]).toBe(true);
    const oldHash = before[1].file.hash;
    const sandbox = createSandboxTestContext({
      overrides: {
        sessionKey: target.sessionKey,
        workspaceDir: state.workspaceDir,
        workspaceSource: undefined,
      },
    });
    const input = {
      context,
      target,
      entry,
      sandbox,
      assertCurrent() {},
      async verifyBeforeBinding() {},
    };
    const beforeUnsupported = loadSessionEntryReadOnly(target);
    await expect(
      adoptUnboundPullRequestWorkspace({
        ...input,
        sandbox: { ...sandbox, backendId: "ssh" },
      }),
    ).rejects.toThrow("require a local Docker or Podman sandbox");
    expect(loadSessionEntryReadOnly(target)).toEqual(beforeUnsupported);
    expect(await managedWorktrees.findLiveByOwner("session", target.sessionKey)).toBeUndefined();
    const exec = createExecTool({
      ...fullGatewayExec,
      config: cfg,
      agentId: "main",
      sessionKey: target.sessionKey,
      scopeKey: target.sessionKey,
      allowBackground: true,
      notifyOnExit: false,
    });
    const background = runningSession(
      (
        await exec.execute("background", {
          command: nodeCommand(
            `require("node:fs").watch(${JSON.stringify(state.workspaceDir)}, () => {})`,
          ),
          background: true,
        })
      ).details,
    );
    const process = createProcessTool({ scopeKey: target.sessionKey });
    try {
      await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toThrow("background work");
      expect(getSession(background.sessionId)?.exited).toBe(false);
      expect(loadSessionEntryReadOnly(target)?.worktree).toBeUndefined();
    } finally {
      await process.execute("stop-fixture", { action: "kill", sessionId: background.sessionId });
      await waitForExecScope(target.sessionKey);
      acknowledgeInternalToolResult(
        await process.execute("observe-fixture", {
          action: "poll",
          sessionId: background.sessionId,
        }),
      );
    }
    const allocate = allocation.prepareSessionWorktree;
    let queued: ReturnType<typeof reserveSessionControllerSource> | undefined;
    const duringPreparation = vi
      .spyOn(allocation, "prepareSessionWorktree")
      .mockImplementationOnce(async (...args) => {
        const result = await allocate(...args);
        queued = reserveSessionControllerSource(target.sessionKey, {
          policy: { mode: "followup" },
          target: captureSessionTarget({
            storeScope: target.storePath,
            sessionKey: target.sessionKey,
            agentId: target.agentId,
            incarnation: entry.sessionId,
          }),
        });
        return result;
      });
    try {
      await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toThrow("queued input");
      expect(queued?.phase).toBe("preparing");
      expect(loadSessionEntryReadOnly(target)?.worktree).toBeUndefined();
      expect(await managedWorktrees.findLiveByOwner("session", target.sessionKey)).toBeUndefined();
    } finally {
      duringPreparation.mockRestore();
      if (queued) {
        retireSessionControllerInput(queued);
        await queued.settlement.promise;
      }
    }
    let committing: admission.SqliteWorkerOperationAdmission | undefined;
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    const captureAdmission = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) => {
        const owned = createAdmission((admissionRequest, grant) => {
          if (admissionRequest.stage === "commit") {
            committing = owned;
          }
          callback(admissionRequest, grant);
        }, attachment);
        return owned;
      });
    const restoreSettlement: Array<() => void> = [];
    const lostCommit = vi.fn(() => {
      expect(committing?.committed?.facts).toMatchObject({
        kind: "session-entry-patch-committed",
      });
      if (!committing) {
        throw new Error("Workspace binding did not reach native commit admission");
      }
      const settlement = vi
        .spyOn(committing, "settlement", "get")
        .mockReturnValue({ kind: "unknown" });
      restoreSettlement.push(() => settlement.mockRestore());
      throw new Error("Lost source-commit acknowledgement");
    });
    getSessionEntryPatchDelivery().afterCommit = lostCommit;
    try {
      await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toMatchObject({
        code: "outcome-unknown",
      });
      expect(lostCommit).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly(target)?.worktree?.id).toBeDefined();
    } finally {
      getSessionEntryPatchDelivery().afterCommit = undefined;
      restoreSettlement.forEach((restore) => restore());
      captureAdmission.mockRestore();
    }
    const adopted = await adoptUnboundPullRequestWorkspace({
      context,
      target,
      entry: loadSessionEntryReadOnly(target)!,
      sandbox,
      assertCurrent() {},
      async verifyBeforeBinding() {},
    });
    const worktree = await managedWorktrees.findLiveByOwner("session", target.sessionKey);
    expect(worktree).toBeDefined();
    try {
      expect(adopted.sessionId).toBe(entry.sessionId);
      expect(projectPublicSessionEntry(adopted)).not.toHaveProperty("priorWorkspace");
      expect(adopted.priorWorkspace).toMatchObject({
        sessionId: "adopt",
        fileRoot: state.workspaceDir,
      });
      expect(await fs.readdir(worktree!.path)).toEqual([".git"]);
      expect(loadSessionEntryReadOnly(sibling)).toEqual(siblingBefore);
      await fs.writeFile(path.join(worktree!.path, "notes.md"), "same original bytes\n");
      const nextMessage = await manager.appendMessageAsync(
        makeUserMessage("Open the new notes.md", 2),
      );
      assert(nextMessage, "Current-source message must be persisted");
      for (const expectedSource of [
        undefined,
        { workspaceId: "another-workspace", root: worktree!.path, fileRoot: worktree!.path },
      ]) {
        const rejected = await request("set", {
          content: "stale draft",
          expectedHash: oldHash,
          ...(expectedSource ? { expectedSource } : {}),
        });
        expect(rejected[0]).toBe(false);
        expect(rejected[2]).toMatchObject({ details: { type: "session_file_source_changed" } });
      }
      expect(await fs.readFile(path.join(worktree!.path, "notes.md"), "utf8")).toBe(
        "same original bytes\n",
      );
      const current = await request("get", { messageEntryId: nextMessage });
      expect(current[0]).toBe(true);
      expect(current[1]).toMatchObject({
        source: { workspaceId: worktree!.id },
        file: { hash: oldHash },
      });
      const saved = await request("set", {
        content: "current source edit\n",
        expectedHash: oldHash,
        expectedSource: current[1].source,
      });
      expect(saved[0]).toBe(true);
      const historical = await request("get", { messageEntryId: oldMessage });
      expect(historical[0]).toBe(true);
      expect(historical[1].file.content).toBe("same original bytes\n");
      expect(historical[1].file.hash).toBeUndefined();
      expect(historical[1].source).toBeUndefined();
      const assistant = makeAssistantMessageFixture({
        stopReason: "stop",
        content: [{ type: "text", text: "Imported the PR" }],
      });
      const assistantId = await manager.appendMessageAsync(assistant);
      assert(assistantId, "Assistant rewrite target must be persisted");
      const scope = { ...target, sessionId: entry.sessionId };
      const beforeRewrite = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: [assistantId],
        includeWatermark: true,
      });
      await rewritePreparedTranscriptMessageAtAnchor(beforeRewrite.anchors[0]!, () => ({
        ...assistant,
        content: [{ type: "text" as const, text: "Imported the PR with an attachment" }],
      }));
      const rewritten = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: [oldMessage],
        includeWatermark: true,
      });
      expect(rewritten.watermark?.generation).not.toBe(beforeRewrite.watermark?.generation);
      const afterMedia = await request("get", { messageEntryId: oldMessage });
      expect(afterMedia[1].file).toMatchObject({ content: "same original bytes\n" });
      expect(afterMedia[1].file.hash).toBeUndefined();
      expect((await request("get", { messageEntryId: nextMessage }))[1].file.content).toBe(
        "current source edit\n",
      );
      const refreshed = await SessionManager.openAsync(scope, state.workspaceDir);
      expect(
        await refreshed.removeTrailingEntriesAsync((message) => message.id === boundaryMessage, {
          preserveTrailing: (message) => message.id === nextMessage || message.id === assistantId,
        }),
      ).toBe(1);
      expect(refreshed.getEntry(nextMessage)?.parentId).toBe(oldMessage);
      expect(refreshed.getEntry(assistantId)?.parentId).toBe(nextMessage);
      const afterSuffix = await request("get", { messageEntryId: oldMessage });
      expect(afterSuffix[1].file).toMatchObject({ content: "same original bytes\n" });
      expect(afterSuffix[1].file.hash).toBeUndefined();
      expect((await request("get", { messageEntryId: nextMessage }))[0]).toBe(false);
      await refreshed.branchAsync(assistantId);
      const resumedMessage = await refreshed.appendMessageAsync(
        makeUserMessage("Continue the retained PR branch", 3),
      );
      assert(resumedMessage, "Resumed branch message must be persisted");
      await waitForSessionTranscriptProjection(scope);
      const resumedAnchors = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: [oldMessage, nextMessage, assistantId, resumedMessage],
      });
      expect(resumedAnchors.anchors.map((anchor) => anchor.entryId)).toEqual([
        oldMessage,
        nextMessage,
        assistantId,
        resumedMessage,
      ]);
      const originalAfterBranch = await request("get", { messageEntryId: oldMessage });
      expect(originalAfterBranch).toMatchObject([
        true,
        { file: { content: "same original bytes\n" } },
      ]);
      expect(originalAfterBranch[1].file.hash).toBeUndefined();
      expect(originalAfterBranch[1].source).toBeUndefined();
      const currentAfterBranch = await request("get", { messageEntryId: nextMessage });
      expect(currentAfterBranch).toMatchObject([
        true,
        { file: { content: "current source edit\n" } },
      ]);
      expect((await request("get", { messageEntryId: boundaryMessage }))[0]).toBe(false);
      expect((await request("get", { messageEntryId: "forged-message" }))[0]).toBe(false);
      await fs.writeFile(
        path.join(state.workspaceDir, "index.html"),
        '<link rel="stylesheet" href="style.css">',
      );
      await fs.writeFile(path.join(state.workspaceDir, "style.css"), "body { color: blue; }");
      await fs.writeFile(path.join(worktree!.path, "style.css"), "body { color: red; }");
      const assets = await request("assets", {
        path: "index.html",
        refs: ["style.css"],
        messageEntryId: oldMessage,
      });
      expect(assets[0]).toBe(true);
      expect(Buffer.from(assets[1].assets[0].content, "base64").toString()).toBe(
        "body { color: blue; }",
      );
      const repeated = await adoptUnboundPullRequestWorkspace({
        context,
        target,
        entry: loadSessionEntryReadOnly(target)!,
        sandbox,
        assertCurrent() {},
        async verifyBeforeBinding() {},
      });
      expect(repeated.worktree?.id).toBe(worktree!.id);
      expect(await fs.readFile(path.join(worktree!.path, "notes.md"), "utf8")).toBe(
        "current source edit\n",
      );
      expect(await fs.readFile(path.join(state.workspaceDir, "notes.md"), "utf8")).toBe(
        "same original bytes\n",
      );
      expect(loadSessionEntryReadOnly(sibling)).toEqual(siblingBefore);
    } finally {
      if (worktree) {
        await managedWorktrees.remove({
          id: worktree.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  });
});
