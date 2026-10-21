import { runClientCredentialOperation } from "./client-credential-store.js";
import type { ReadonlyExecApprovalsFile } from "./exec-approvals-core.js";
import { updateExecApprovalsForMaintenance } from "./exec-approvals-maintenance.js";

export function saveExecApprovals(file: ReadonlyExecApprovalsFile): void {
  updateExecApprovalsForMaintenance({ update: () => file });
  if (file.socket?.path || file.socket?.token) {
    runClientCredentialOperation(process.env, {
      kind: "socket.ensure",
      fallback: {
        socket_key: "current",
        socket_path: file.socket.path ?? null,
        socket_token: file.socket.token ?? null,
        updated_at_ms: Date.now(),
      },
      requested: file.socket,
    });
  }
}

type ExecApprovalsStoreTestApi = {
  reset(): void;
};

function getTesting(): ExecApprovalsStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.execApprovalsStoreTestApi")
  ] as ExecApprovalsStoreTestApi;
}

export const testing: ExecApprovalsStoreTestApi = {
  reset: () => getTesting().reset(),
};
