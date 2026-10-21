// Revalidates and commits exec authority against the current policy.
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createExecApprovalPolicySnapshot } from "./exec-approvals-allow-always.js";
import { assertCurrentUsageAuthorization } from "./exec-approvals-authorization.kernel.js";
import type {
  ExecApprovalUsageAuthorization,
  ExecAuthorizationCommitInput,
} from "./exec-approvals-contracts.js";
import { buildAllowlistEntryMatchKey } from "./exec-approvals-resolver.js";
import { commitExecAuthorizations } from "./exec-approvals-store.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type { ExecApprovalUsageAuthorization } from "./exec-approvals-contracts.js";

export async function recordAllowlistMatchesUse(
  params: {
    agentId: string | undefined;
    matches: readonly ExecAllowlistEntry[];
    command: string;
    resolvedPath?: string;
    authorization: ExecApprovalUsageAuthorization;
    assertCurrent?: () => void;
  },
  context?: OpenClawStateWorkerContext,
): Promise<() => void> {
  const input: ExecAuthorizationCommitInput = {
    agentId: params.agentId,
    matches: params.matches,
    command: params.command,
    resolvedPath: params.resolvedPath,
    authorization: params.authorization,
  };
  return retainedAuthorization(
    await commitExecAuthorizations(input, params.assertCurrent, context),
  );
}

export async function commitExecAuthorizationLocked(
  input: ExecAuthorizationCommitInput,
): Promise<() => void> {
  return retainedAuthorization(await commitExecAuthorizations(input));
}

function retainedAuthorization({
  input: params,
  file,
  readCurrent,
}: Awaited<ReturnType<typeof commitExecAuthorizations>>): () => void {
  const matchKeys = new Set(
    params.matches.filter((entry) => entry.pattern).map(buildAllowlistEntryMatchKey),
  );
  // Our own allow-always write is part of the committed policy. Later checks
  // only read; a PTY retry must neither replay that write nor reject its result.
  const authorization = {
    ...params.authorization,
    policySnapshot: createExecApprovalPolicySnapshot({
      file,
      agentId: params.agentId,
    }),
  };
  return () =>
    assertCurrentUsageAuthorization({
      file: readCurrent(),
      agentId: params.agentId,
      command: params.command,
      matchKeys,
      authorization,
    });
}
