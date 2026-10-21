import { describe, expect, it } from "vitest";
import {
  type ExecApprovalPolicySnapshot,
  normalizeExecApprovalPolicySnapshot,
} from "./exec-approval-policy-snapshot.js";
import {
  isExecApprovalPolicySnapshotCurrent,
  readExecApprovalPolicyFacts,
  resolveExecApprovalsPolicy,
  retainExecApprovalsPolicy,
} from "./exec-approvals-resolver.js";

const policy: ExecApprovalPolicySnapshot = {
  security: "allowlist",
  ask: "on-miss",
  askFallback: "deny",
  autoAllowSkills: false,
  allowlistRules: [],
};

describe("exec approval policy rule identity", () => {
  it("shares semantic facts across usage writes without mixing agents or runtime overrides", () => {
    const file = retainExecApprovalsPolicy({
      version: 1,
      agents: {
        main: { security: "allowlist", allowlist: [{ id: "main", pattern: "/bin/echo" }] },
        "*": { allowlist: [{ id: "wildcard", pattern: "/bin/date" }] },
      },
    });
    const main = readExecApprovalPolicyFacts(file, "main");
    const unknown = readExecApprovalPolicyFacts(file, "unknown");
    expect(main.snapshot.allowlistRules).toEqual([
      { pattern: "/bin/date" },
      { pattern: "/bin/echo" },
    ]);
    expect(unknown.snapshot.allowlistRules).toEqual([{ pattern: "/bin/date" }]);
    for (const security of ["deny", "full", "deny"] as const) {
      expect(
        resolveExecApprovalsPolicy({ file, agentId: "unknown", overrides: { security } }).agent
          .security,
      ).toBe(security);
      expect(readExecApprovalPolicyFacts(file, "main")).toBe(main);
      expect(readExecApprovalPolicyFacts(file, undefined)).toBe(unknown);
    }
    const used = retainExecApprovalsPolicy(
      {
        ...file,
        agents: {
          ...file.agents,
          main: {
            ...file.agents?.main,
            allowlist: [{ ...file.agents!.main!.allowlist![0]!, lastUsedAt: 123 }],
          },
        },
      },
      file,
    );
    expect(readExecApprovalPolicyFacts(used, "main")).toBe(main);
    expect(
      resolveExecApprovalsPolicy({ file: used, agentId: "main" }).allowlist[1]?.lastUsedAt,
    ).toBe(123);
    expect(
      resolveExecApprovalsPolicy({ file, agentId: "main" }).allowlist[1]?.lastUsedAt,
    ).toBeUndefined();
    const revoked = retainExecApprovalsPolicy({ ...used, agents: { "*": file.agents!["*"]! } });
    const current = readExecApprovalPolicyFacts(revoked, "main");
    expect(
      isExecApprovalPolicySnapshotCurrent(main.snapshot, current.snapshot, current.ruleKeys),
    ).toBe(false);
  });

  it("keeps delimiter-containing rule tuples distinct when normalizing and checking policy", () => {
    const first = { pattern: "command", argPattern: "argument\0tail" };
    const second = { pattern: "command\0argument", argPattern: "tail" };

    expect(
      normalizeExecApprovalPolicySnapshot({
        ...policy,
        allowlistRules: [first, second],
      }),
    ).toEqual({ ...policy, allowlistRules: [first, second] });
    expect(
      isExecApprovalPolicySnapshotCurrent(
        { ...policy, allowlistRules: [first] },
        { ...policy, allowlistRules: [second] },
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "accepts a manual rule upgraded to allow-always alongside an additive grant",
      expectedSource: undefined,
      currentSource: "allow-always" as const,
      accepted: true,
    },
    {
      name: "rejects an allow-always rule downgraded to manual despite an additive grant",
      expectedSource: "allow-always" as const,
      currentSource: undefined,
      accepted: false,
    },
  ])("$name", ({ expectedSource, currentSource, accepted }) => {
    expect(
      isExecApprovalPolicySnapshotCurrent(
        {
          ...policy,
          allowlistRules: [{ pattern: "command", argPattern: "^safe$", source: expectedSource }],
        },
        {
          ...policy,
          allowlistRules: [
            { pattern: "command", argPattern: "^safe$", source: currentSource },
            { pattern: "other-command" },
          ],
        },
      ),
    ).toBe(accepted);
  });
});
