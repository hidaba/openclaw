// Exec approval policy file helpers without the broad infra-runtime barrel.
import {
  loadExecApprovals as loadExecApprovalsSync,
  loadExecApprovalsReadOnlyAsync as loadExecApprovalsReadOnlyInternal,
  readExecApprovalsSnapshot as readExecApprovalsSnapshotSync,
  readExecApprovalsSnapshotAsync as readExecApprovalsSnapshotInternal,
  resolveExecApprovalsFromFile as resolveExecApprovalsFromFileInternal,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
  type ExecApprovalsResolved,
} from "../infra/exec-approvals.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

/** @deprecated Await loadExecApprovalsReadOnlyAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
function loadExecApprovalsDeprecated(): ExecApprovalsFile {
  warnPluginSdkDeprecation({
    family: "exec-approvals-sync-read",
    method: "loadExecApprovals",
    replacement: "loadExecApprovalsReadOnlyAsync",
  });
  return structuredClone(loadExecApprovalsSync()) as ExecApprovalsFile;
}

/** @deprecated Await readExecApprovalsSnapshotAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
function readExecApprovalsSnapshotDeprecated(): ExecApprovalsSnapshot {
  warnPluginSdkDeprecation({
    family: "exec-approvals-sync-read",
    method: "readExecApprovalsSnapshot",
    replacement: "readExecApprovalsSnapshotAsync",
  });
  return structuredClone(readExecApprovalsSnapshotSync()) as ExecApprovalsSnapshot;
}

export {
  loadExecApprovalsDeprecated as loadExecApprovals,
  readExecApprovalsSnapshotDeprecated as readExecApprovalsSnapshot,
};

// Released SDK reads remain detached and mutable; only internal readers share generations.
async function loadDetachedExecApprovalsReadOnlyAsync(
  ...args: Parameters<typeof loadExecApprovalsReadOnlyInternal>
): Promise<ExecApprovalsFile> {
  return structuredClone(await loadExecApprovalsReadOnlyInternal(...args)) as ExecApprovalsFile;
}

async function readDetachedExecApprovalsSnapshotAsync(
  ...args: Parameters<typeof readExecApprovalsSnapshotInternal>
): Promise<ExecApprovalsSnapshot> {
  return structuredClone(await readExecApprovalsSnapshotInternal(...args)) as ExecApprovalsSnapshot;
}

function resolveDetachedExecApprovalsFromFile(
  ...args: Parameters<typeof resolveExecApprovalsFromFileInternal>
): ExecApprovalsResolved {
  return structuredClone(resolveExecApprovalsFromFileInternal(...args)) as ExecApprovalsResolved;
}

export {
  loadDetachedExecApprovalsReadOnlyAsync as loadExecApprovalsReadOnlyAsync,
  readDetachedExecApprovalsSnapshotAsync as readExecApprovalsSnapshotAsync,
  resolveDetachedExecApprovalsFromFile as resolveExecApprovalsFromFile,
};

export {
  resolveExecApprovalsDisplayPath,
  resolveExecModePolicy,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
