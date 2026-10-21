import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { REDACTED_SENTINEL } from "../src/config/redact-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const HEADER_SECRET = "Bearer e2e-live-mcp-header-secret-value";
const ENV_SECRET = "e2e-live-mcp-env-secret-value";
const ARG_SECRET = "e2e-live-mcp-argv-secret-value";
const ARG_INLINE_SECRET = "e2e-live-mcp-inline-argv-secret-value";
const ARG_POSITIONAL_SECRET = "ghp_e2elivemcpargvtoken1234567890ABCD";
const SERVER_NAME = "billing-server";
const serverConnection = {
  command: "uvx",
  transport: "streamable-http",
  url: "https://billing.example.com/mcp",
} as const;

const serverSecrets = (redacted = false) => ({
  headers: { Authorization: redacted ? REDACTED_SENTINEL : HEADER_SECRET },
  env: { BILLING_TOKEN: redacted ? REDACTED_SENTINEL : ENV_SECRET },
});
const serverArgs = [
  "billing-mcp",
  "--api-key",
  ARG_SECRET,
  `--token=${ARG_INLINE_SECRET}`,
  ARG_POSITIONAL_SECRET,
  "--region",
  "us-east-1",
];

async function readServer(instance: OpenClawTestInstance) {
  const config = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as OpenClawConfig;
  return config.mcp?.servers?.[SERVER_NAME];
}

function expectRedacted(text: string) {
  expect(text).toContain(REDACTED_SENTINEL);
  for (const secret of [
    HEADER_SECRET,
    ENV_SECRET,
    ARG_SECRET,
    ARG_INLINE_SECRET,
    ARG_POSITIONAL_SECRET,
    "e2e-live-mcp-header-secret-value",
    "e2e-live-mcp-env-secret-value",
  ]) {
    expect(text).not.toContain(secret);
  }
}

type ChatEventPayload = {
  runId?: string;
  state?: string;
  message?: unknown;
  errorMessage?: string;
};

function collectFinalText(payload: ChatEventPayload): string {
  return (
    extractFirstTextBlock(payload.message) ||
    (typeof payload.errorMessage === "string" ? payload.errorMessage : JSON.stringify(payload))
  );
}

async function waitForChatFinal(
  events: Array<{ event?: string; payload?: unknown }>,
  runId: string,
): Promise<ChatEventPayload> {
  return vi.waitFor(
    () => {
      for (const event of events) {
        if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
          continue;
        }
        const payload = event.payload as ChatEventPayload;
        if (payload.runId === runId && payload.state === "final") {
          return payload;
        }
      }
      throw new Error(
        `waiting for chat final runId=${runId}; events=${JSON.stringify(events.slice(-12))}`,
      );
    },
    { timeout: 45_000, interval: 10 },
  );
}

it(
  "starts an ephemeral gateway and redacts MCP secrets from /mcp show chat replies",
  { timeout: 180_000 },
  async () => {
    const instance = await createOpenClawTestInstance({
      name: "mcp-show-redact",
      env: { OPENCLAW_TEST_FAST: "1" },
      config: {
        commands: { text: true, mcp: true },
        mcp: {
          servers: {
            [SERVER_NAME]: {
              ...serverConnection,
              args: serverArgs,
              ...serverSecrets(),
            },
          },
        },
      },
    });
    onTestFinished(() => instance.cleanup());
    await instance.startGateway();

    expect((await readServer(instance))?.headers?.Authorization).toBe(HEADER_SECRET);

    const events: Array<{ event?: string; payload?: unknown }> = [];
    const client = await connectProofClient(instance, {
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        events.push(event);
      },
    });

    async function chat(message: string) {
      const runId = randomUUID();
      await client.request("chat.send", {
        sessionKey: "agent:main:main",
        message,
        deliver: false,
        idempotencyKey: runId,
      });
      return collectFinalText(await waitForChatFinal(events, runId));
    }

    try {
      const namedText = await chat(`/mcp show ${SERVER_NAME}`);

      expect(namedText).toContain(`MCP server "${SERVER_NAME}"`);
      expect(namedText).toContain('"command": "uvx"');
      expectRedacted(namedText);
      expect(namedText).toContain('"billing-mcp"');
      expect(namedText).toContain('"--api-key"');
      expect(namedText).toContain(`"--token=${REDACTED_SENTINEL}"`);
      expect(namedText).toContain('"--region"');
      expect(namedText).toContain('"us-east-1"');
      const setPayload = {
        ...serverConnection,
        ...serverSecrets(true),
      };
      const setText = await chat(`/mcp set ${SERVER_NAME}=${JSON.stringify(setPayload)}`);
      expect(setText).toContain(`MCP server "${SERVER_NAME}" saved`);

      const saved = await readServer(instance);
      expect(saved).toMatchObject({ command: "uvx", ...serverSecrets() });
      expect(JSON.stringify(saved)).not.toContain(REDACTED_SENTINEL);
    } finally {
      client.stop();
    }
  },
);
