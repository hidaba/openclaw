import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

export function createPendingInputFixture(
  prefix: string,
  sessionKey: string,
  sessionId: string,
  content: string,
  timestamp: number,
  afterClose?: () => void,
) {
  const fixture = useTempSessionsFixture(prefix);
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const options = () => toDatabaseOptions(resolveSqliteScope(scope()));
  const database = () => openOpenClawAgentDatabase(options());
  const receipts: SessionPendingInputReceipt[] = [];
  const message = (runId: string, text = content): PersistedUserTurnMessage => ({
    role: "user",
    content: text,
    timestamp,
    idempotencyKey: runId + ":user",
  });
  const request = (
    runId: string,
    params: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
    target = scope(),
  ) =>
    stageSessionPendingInput(target, {
      runId,
      message: message(runId),
      assertCurrent: () => {},
      ...params,
    });
  const stage = async (
    runId: string,
    params: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
    target = scope(),
  ) => {
    const receipt = expectDefined(
      await request(runId, params, target),
      "Expected staged input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const finish = async (
    receipt: SessionPendingInputReceipt,
    reason: Parameters<SessionPendingInputReceipt["finish"]>[0] = "interrupted",
  ) => {
    receipt.finish(reason);
    await receipt.settled?.();
  };
  const close = async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  };
  const restart = async () => {
    rotateAgentEventLifecycleGeneration();
    await close();
  };
  afterEach(async () => {
    const retained = receipts.splice(0);
    for (const receipt of retained) {
      receipt.finish("interrupted");
    }
    await Promise.allSettled(retained.map(async (receipt) => receipt.settled?.()));
    await close();
    afterClose?.();
  });
  return {
    fixture,
    scope,
    options,
    database,
    receipts,
    message,
    request,
    stage,
    finish,
    close,
    restart,
  };
}
