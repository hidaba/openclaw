// Doctor-only native policy updates; runtime edits use the shared-state writer.
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  ReadonlyExecApprovalsFile,
  ReadonlyExecApprovalsSnapshot,
} from "./exec-approvals-core.js";
import { stageCronExecHostPolicyPublication } from "./exec-approvals-cron-policy.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import {
  assertExecApprovalsMutationAllowed,
  serializeExecApprovals,
  snapshotFromExecApprovalsDatabase,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";

type NativeExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ReadonlyExecApprovalsFile) => ReadonlyExecApprovalsFile | null;
  assertCurrent?: () => void;
};

/** Doctor retains its synchronous native migration transaction. Runtime edits use the writer. */
export function updateExecApprovalsForMaintenance(
  params: NativeExecApprovalsUpdate,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlyExecApprovalsSnapshot | null {
  assertNoPendingLegacyExecApprovals();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent?.();
      const current = snapshotFromExecApprovalsDatabase(db);
      if (params.baseHash !== undefined && current.hash !== params.baseHash) {
        return null;
      }
      const next = params.update(current.file);
      if (next === null) {
        return current;
      }
      assertExecApprovalsMutationAllowed({
        db,
        current: current.file,
        next,
      });
      const raw = serializeExecApprovals(next);
      if (current.exists && current.raw === raw) {
        return current;
      }
      const persistedRaw = writeExecApprovalsConfigRow({ db, file: next });
      const snapshot = snapshotFromExecApprovalsRow({
        path: current.path,
        row: { raw_json: persistedRaw },
      });
      stageCronExecHostPolicyPublication(db, snapshot.file);
      params.assertCurrent?.();
      return snapshot;
    },
    options,
    { operationLabel: "exec-approvals.update" },
  );
}
