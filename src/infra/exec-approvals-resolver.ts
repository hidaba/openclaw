// Resolves normalized exec approval policy without persistence side effects.
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import {
  buildExecApprovalPolicyRuleKey,
  canonicalizeExecApprovalPolicyRules,
  type ReadonlyExecApprovalPolicySnapshot,
} from "./exec-approval-policy-snapshot.js";
import {
  DEFAULT_ASK,
  DEFAULT_AUTO_ALLOW_SKILLS,
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  DEFAULT_SECURITY,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
import type {
  ExecApprovalsDefaults,
  ReadonlyExecApprovalsFile,
  ReadonlyExecApprovalsResolved,
} from "./exec-approvals-core.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import { expandHomePrefix } from "./home-dir.js";

type ResolvedPolicy = Pick<
  ReadonlyExecApprovalsResolved,
  "defaults" | "agent" | "agentSources" | "allowlist" | "file"
>;
type PolicyFacts = Readonly<{
  snapshot: ReadonlyExecApprovalPolicySnapshot;
  ruleKeys: ReadonlySet<string>;
  matchKeys: ReadonlySet<string>;
  durableKeys: ReadonlySet<string>;
}>;
type PreparedPolicy = {
  resolutions: Map<string, ResolvedPolicy>;
  facts: Map<string | undefined, PolicyFacts>;
};
const preparedPolicies = new WeakMap<ReadonlyExecApprovalsFile, PreparedPolicy>();
const snapshotRequirements = new WeakMap<
  ReadonlyExecApprovalPolicySnapshot,
  readonly (readonly [string, string | undefined])[]
>();

function policyRequirements(
  snapshot: ReadonlyExecApprovalPolicySnapshot,
): readonly (readonly [string, string | undefined])[] {
  return snapshot.allowlistRules.map(
    (rule) =>
      [
        buildExecApprovalPolicyRuleKey(rule),
        rule.source === undefined
          ? buildExecApprovalPolicyRuleKey({ ...rule, source: "allow-always" })
          : undefined,
      ] as const,
  );
}

export function isExecApprovalPolicySnapshotCurrent(
  expected: ReadonlyExecApprovalPolicySnapshot,
  current: ReadonlyExecApprovalPolicySnapshot,
  preparedRuleKeys?: ReadonlySet<string>,
): boolean {
  if (expected === current) {
    return true;
  }
  if (
    expected.security !== current.security ||
    expected.ask !== current.ask ||
    expected.askFallback !== current.askFallback ||
    expected.autoAllowSkills !== current.autoAllowSkills
  ) {
    return false;
  }
  const currentKeys =
    preparedRuleKeys ?? new Set(current.allowlistRules.map(buildExecApprovalPolicyRuleKey));
  // Additive grants and source upgrades preserve authority; revocation/downgrade does not.
  for (const rule of snapshotRequirements.get(expected) ?? policyRequirements(expected)) {
    if (!currentKeys.has(rule[0]) && (rule[1] === undefined || !currentKeys.has(rule[1]))) {
      return false;
    }
  }
  return true;
}

/** Only decoded canonical rows, validated receipts and owner-authored COW writes enter here. */
export function retainExecApprovalsPolicy(
  file: ReadonlyExecApprovalsFile,
  usageOf?: ReadonlyExecApprovalsFile,
): ReadonlyExecApprovalsFile {
  if (!preparedPolicies.has(file)) {
    freezeTrustedJsonSnapshot(file);
    preparedPolicies.set(file, {
      resolutions: new Map(),
      // Usage writers cannot change policy semantics; receipts retain that distinction.
      facts: (usageOf && preparedPolicies.get(usageOf)?.facts) || new Map(),
    });
  }
  return file;
}

export function buildAllowlistEntryMatchKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern">,
): string {
  return JSON.stringify([entry.pattern, entry.argPattern ?? null]);
}

export function readExecApprovalPolicyFacts(
  file: ReadonlyExecApprovalsFile,
  agentId: string | undefined,
): PolicyFacts {
  const retained = preparedPolicies.get(file);
  // Unknown agent names all select the same defaults and wildcard policy.
  const agentKey = agentId ?? "default";
  const key = Object.hasOwn(file.agents ?? {}, agentKey) ? agentKey : undefined;
  const cached = retained?.facts.get(key);
  if (cached) {
    return cached;
  }
  const resolved = resolveExecApprovalsPolicy({ file, agentId });
  const snapshot = freezeTrustedJsonSnapshot({
    ...resolved.agent,
    allowlistRules: canonicalizeExecApprovalPolicyRules(
      resolved.allowlist.map(({ pattern, argPattern, source }) => ({
        pattern,
        ...(argPattern !== undefined ? { argPattern } : {}),
        ...(source === "allow-always" ? { source } : {}),
      })),
    ),
  });
  snapshotRequirements.set(snapshot, policyRequirements(snapshot));
  const facts = {
    snapshot,
    ruleKeys: new Set(snapshot.allowlistRules.map(buildExecApprovalPolicyRuleKey)),
    matchKeys: new Set(resolved.allowlist.map(buildAllowlistEntryMatchKey)),
    durableKeys: new Set(
      resolved.allowlist
        .filter((entry) => entry.source === "allow-always")
        .map(buildAllowlistEntryMatchKey),
    ),
  };
  retained?.facts.set(key, facts);
  return facts;
}

type ResolvePolicyParams = {
  file: ReadonlyExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
};

export function resolveExecApprovalsPolicy(params: ResolvePolicyParams): ResolvedPolicy {
  const rawFile = params.file;
  const retained = preparedPolicies.get(rawFile);
  const cacheKey =
    retained &&
    JSON.stringify([
      params.agentId,
      params.overrides?.security,
      params.overrides?.ask,
      params.overrides?.askFallback,
      params.overrides?.autoAllowSkills,
    ]);
  const cached = cacheKey && retained?.resolutions.get(cacheKey);
  if (cached) {
    return cached;
  }
  const file = retained ? rawFile : normalizeExecApprovalsInternal(rawFile);
  const defaults: ExecApprovalsDefaults = file.defaults ?? {};
  const agentKey = params.agentId ?? "default";
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const rawAgent = rawFile.agents?.[agentKey] ?? {};
  const rawWildcard = rawFile.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_EXEC_APPROVAL_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: defaults.security ?? fallbackSecurity,
    ask: defaults.ask ?? fallbackAsk,
    askFallback: defaults.askFallback ?? fallbackAskFallback,
    autoAllowSkills: defaults.autoAllowSkills ?? fallbackAutoAllowSkills,
  };
  const resolveField = <TField extends "security" | "ask" | "askFallback">(
    field: TField,
  ): { value: Required<ExecApprovalsDefaults>[TField]; source: string | null } => {
    const defaultValue = defaults[field];
    const fallbackField =
      defaultValue !== undefined
        ? { value: defaultValue, source: `defaults.${field}` }
        : { value: resolvedDefaults[field], source: null };
    const agentOverrides = rawAgent[field] != null;
    const policy: ExecApprovalsDefaults | undefined = agentOverrides
      ? agent
      : rawWildcard[field] != null
        ? wildcard
        : undefined;
    const value = policy?.[field];
    return value !== undefined
      ? { value, source: `agents.${agentOverrides ? agentKey : "*"}.${field}` }
      : fallbackField;
  };
  const resolvedAgentSecurity = resolveField("security");
  const resolvedAgentAsk = resolveField("ask");
  const resolvedAgentAskFallback = resolveField("askFallback");
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: resolvedAgentSecurity.value,
    ask: resolvedAgentAsk.value,
    askFallback: resolvedAgentAskFallback.value,
    autoAllowSkills:
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
  };
  const allowlist = [...(wildcard.allowlist ?? []), ...(agent.allowlist ?? [])];
  const resolved = {
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    agentSources: {
      security: resolvedAgentSecurity.source,
      ask: resolvedAgentAsk.source,
      askFallback: resolvedAgentAskFallback.source,
    },
    allowlist,
    file,
  };
  if (cacheKey && retained) {
    // Overrides and agent selection are request shape, never authority.
    if (retained.resolutions.size >= 64) {
      retained.resolutions.delete(retained.resolutions.keys().next().value!);
    }
    retained.resolutions.set(cacheKey, freezeTrustedJsonSnapshot(resolved));
  }
  return resolved;
}

export function resolveExecApprovalsFromFileInternal(
  params: ResolvePolicyParams & {
    path?: string;
    socketPath?: string;
    token?: string;
  },
): ReadonlyExecApprovalsResolved {
  const resolved = resolveExecApprovalsPolicy(params);
  return {
    ...resolved,
    path: params.path ?? resolveExecApprovalsDisplayPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? (resolved.file.socket?.path?.trim() || resolveExecApprovalsSocketPath()),
    ),
    token: params.token ?? resolved.file.socket?.token?.trim() ?? "",
  };
}
