import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import { applyExecAuthorizationCommit } from "./exec-approvals-authorization.kernel.js";
import { resolveExecApprovalsDisplayPath } from "./exec-approvals-config.js";
import type {
  ExecAuthorizationCommitInput,
  ExecAuthorizationCommitOutcome,
} from "./exec-approvals-contracts.js";
import type { ReadonlyExecApprovalsFile } from "./exec-approvals-core.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import { execPolicyMutationOperations } from "./exec-approvals-mutation.worker.js";
import { assertExecApprovalsHostPolicyUnchanged } from "./exec-approvals-policy.js";
import { execApprovalsPublication } from "./exec-approvals-publication.js";
import { retainExecApprovalsPolicy } from "./exec-approvals-resolver.js";
import { execApprovalRetirementOperations } from "./exec-approvals-retirement.worker.js";
import {
  snapshotFromExecApprovalsDatabase,
  assertExecApprovalsMutationAllowed,
  ExecApprovalsMutationFencedError,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

function applyAuthorizationBatch(
  db: EngineConnection,
  initial: ReadonlyExecApprovalsFile,
  items: readonly ExecAuthorizationCommitInput[],
) {
  let current = retainExecApprovalsPolicy(initial);
  const outcomes = items.map((item): ExecAuthorizationCommitOutcome => {
    let next: ReturnType<typeof applyExecAuthorizationCommit>;
    try {
      next = applyExecAuthorizationCommit(current, item);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (next !== null || item.requireCommit) {
      try {
        assertExecApprovalsMutationAllowed({
          db,
          current,
          next: next ?? current,
          ...(item.requireCommit ? { agentId: item.agentId } : {}),
        });
      } catch (error) {
        if (!(error instanceof ExecApprovalsMutationFencedError)) {
          throw error;
        }
        return { ok: false, message: error.message };
      }
    }
    if (next !== null) {
      assertExecApprovalsHostPolicyUnchanged(current, next);
      current = retainExecApprovalsPolicy(next);
    }
    return { ok: true, file: current };
  });
  return { file: current, outcomes };
}

export function commitExecAuthorizationsInWorker(
  input: { items: ExecAuthorizationCommitInput[] },
  context: WorkerWriteOperationContext,
): ExecAuthorizationCommitOutcome[] {
  const options = context.stateOptions();
  assertNoPendingLegacyExecApprovals({ env: options.env });
  const displayPath = resolveExecApprovalsDisplayPath(options.env);
  const mayWrite = input.items.some(
    (item) =>
      item.matches.length > 0 ||
      item.requireCommit === true ||
      (item.allowAlwaysDecision !== undefined && item.allowAlwaysDecision.kind !== "one-shot"),
  );
  if (!mayWrite) {
    const { db } = context.open();
    return applyAuthorizationBatch(
      db,
      snapshotFromExecApprovalsDatabase(db, displayPath).file,
      input.items,
    ).outcomes;
  }
  return context.write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const captured = execApprovalsPublication.capture(db, () => {
        const current = snapshotFromExecApprovalsDatabase(db, displayPath);
        const committed = applyAuthorizationBatch(db, current.file, input.items);
        const raw =
          committed.file === current.file ? current.raw : serializeExecApprovals(committed.file);
        if (raw !== current.raw) {
          writeExecApprovalsConfigRow({
            db,
            file: committed.file,
            raw: raw ?? undefined,
            change: input.items.some(
              (item, index) =>
                committed.outcomes[index]?.ok &&
                item.allowAlwaysDecision &&
                item.allowAlwaysDecision.kind !== "one-shot",
            )
              ? "policy"
              : "usage",
          });
        }
        return committed;
      });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      deferSqliteWorkerCommitReceipt(
        db,
        { execFacts: execApprovalsPublication.bound(captured.receipt) },
        captured.receipt.facts.size ? "commit" : "settlement",
      );
      return captured.result.outcomes;
    },
    { operationLabel: "exec-approvals.commit-authorizations" },
  );
}

export const execAuthorizationOperations = {
  ...execApprovalRetirementOperations,
  ...execPolicyMutationOperations,
  "execApprovals.commitAuthorizations": commitExecAuthorizationsInWorker,
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
