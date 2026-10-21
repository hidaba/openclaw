import { raceWithTimeout } from "@openclaw/retry";
import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../packages/gateway-protocol/src/schema/push.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readWebPushAccess, type WebPushAccess } from "./web-push-access.ts";

const SW_READY_TIMEOUT = 10_000;
const VAPID_MISMATCH_MESSAGE =
  "This browser push subscription belongs to another Gateway. Open this Gateway's own Control UI, or configure every mutually trusted Gateway behind this PWA with the same VAPID keypair.";
const WEB_PUSH_USER_PREFERENCES_KEY = "notifications.web.v1";

type WebPushReconcileResult =
  | { state: "missing" }
  | { state: "registered" }
  | { state: "vapid-mismatch"; error: string };

export type WebPushSubscriptionState = WebPushReconcileResult["state"] | "unknown" | "local";

export type WebPushPreferencesResult = {
  durableIdentity: boolean;
  user: WebPushNotificationPreferences;
  device: WebPushDevicePreferences;
  effective: WebPushNotificationPreferences & { enabled: boolean; label: string };
};

export type WebPushCapabilityAction =
  | { kind: "enable" | "disable" | "test" }
  | {
      kind: "set";
      scope: "user" | "device";
      preferences: WebPushNotificationPreferences | WebPushDevicePreferences;
    };

export type WebPushCapabilityPatch = Partial<WebPushAccess> & {
  error?: string | null;
  read?: Promise<void>;
  command?: Promise<void>;
  permission?: NotificationPermission | "unsupported";
  supported?: boolean;
  subscription?: WebPushSubscriptionState;
  preferences?: WebPushPreferencesResult | null;
};

export type WebPushCapabilityRuntime = {
  readonly pending: boolean;
  run: (action: WebPushCapabilityAction) => Promise<void>;
  dispose: () => void;
};

type WebPushClient = Pick<GatewayBrowserClient, "request"> & {
  canReadPreferences: () => boolean;
  assertCanManage: () => void;
};

function webPushClient(gateway: ApplicationGateway, client: GatewayBrowserClient): WebPushClient {
  const profileId = gateway.snapshot.selfUser?.id;
  const access = () => {
    if (
      gateway.snapshot.phase !== "connected" ||
      gateway.snapshot.client !== client ||
      gateway.snapshot.selfUser?.id !== profileId
    ) {
      throw new Error("Gateway changed before the notification change could be saved.");
    }
    return readWebPushAccess(gateway.snapshot);
  };
  const assertCanManage = () => {
    if (!access().canManage) {
      throw new Error("Your Gateway access does not allow managing browser notifications.");
    }
  };
  return {
    assertCanManage,
    canReadPreferences: () => access().canReadPreferences,
    request(...args) {
      const [method] = args;
      if (method === "push.web.preferences.get") {
        if (!access().canReadPreferences) {
          throw new Error("Your Gateway access does not allow reading notification preferences.");
        }
      } else {
        assertCanManage();
      }
      return client.request(...args);
    },
  };
}

function pushManagerFor(registration: ServiceWorkerRegistration | undefined): PushManager | null {
  const manager = registration?.pushManager;
  return manager && typeof manager.getSubscription === "function" ? manager : null;
}

function requirePushManager(registration: ServiceWorkerRegistration): PushManager {
  const manager = pushManagerFor(registration);
  if (!manager || typeof manager.subscribe !== "function") {
    throw new Error(
      "Web Push is unavailable in this browser. On iPhone or iPad, add OpenClaw to the Home Screen and open the installed app.",
    );
  }
  return manager;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  // Passive reads must settle even when no worker is installed or activation is blocked.
  const registration = await navigator.serviceWorker.getRegistration();
  return (await pushManagerFor(registration)?.getSubscription()) ?? null;
}

async function resolveGatewayVapidPublicKey(
  client: Pick<GatewayBrowserClient, "request">,
): Promise<Uint8Array> {
  const { vapidPublicKey } = await client.request<{ vapidPublicKey: string }>(
    "push.web.vapidPublicKey",
    {},
  );
  if (!vapidPublicKey) {
    throw new Error("Failed to retrieve VAPID public key");
  }
  return urlBase64ToUint8Array(vapidPublicKey);
}

function subscriptionUsesVapidKey(
  subscription: PushSubscription,
  vapidPublicKey: Uint8Array,
): boolean {
  const applicationServerKey = subscription.options.applicationServerKey;
  if (!applicationServerKey) {
    return false;
  }
  const currentKey = new Uint8Array(applicationServerKey);
  return (
    currentKey.length === vapidPublicKey.length &&
    currentKey.every((value, index) => value === vapidPublicKey[index])
  );
}

function serializePushSubscription(subscription: PushSubscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Invalid push subscription from browser");
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

async function registerPushSubscription(
  client: Pick<GatewayBrowserClient, "request">,
  subscription: PushSubscription,
  vapidPublicKey: Uint8Array,
): Promise<WebPushReconcileResult> {
  if (!subscriptionUsesVapidKey(subscription, vapidPublicKey)) {
    // Keep the browser subscription for its owning Gateway until the operator
    // explicitly resets it; only this Gateway's unusable row is removed here.
    await client
      .request("push.web.unsubscribe", { endpoint: subscription.endpoint })
      .catch(() => undefined);
    return { state: "vapid-mismatch", error: VAPID_MISMATCH_MESSAGE };
  }
  await client.request("push.web.subscribe", serializePushSubscription(subscription));
  return { state: "registered" };
}

async function resolveWebPushCapabilityPatch(
  client: WebPushClient,
  result: WebPushReconcileResult,
): Promise<WebPushCapabilityPatch> {
  return {
    subscription: result.state,
    preferences:
      result.state === "registered" && client.canReadPreferences()
        ? await getWebPushPreferences(client)
        : null,
    error: result.state === "vapid-mismatch" ? result.error : null,
  };
}

async function reconcileWebPushCapability(
  client: WebPushClient,
  canManage: boolean,
  publish: (patch: WebPushCapabilityPatch) => void,
): Promise<WebPushCapabilityPatch> {
  const subscription = await getExistingSubscription();
  if (subscription && !canManage) {
    publish({ subscription: "local" });
    return {
      subscription: "local",
      preferences: client.canReadPreferences() ? await getWebPushPreferences(client) : null,
      error: null,
    };
  }
  const result = subscription
    ? await registerPushSubscription(
        client,
        subscription,
        await resolveGatewayVapidPublicKey(client),
      )
    : ({ state: "missing" } as const);
  return await resolveWebPushCapabilityPatch(client, result);
}

export function startWebPushReconciliation(params: {
  connectionBootstrap?: ConnectionBootstrapCoordinator;
  gateway: ApplicationGateway;
  publish: (patch: WebPushCapabilityPatch) => void;
}): { retire: () => void; dispose: () => void } {
  let connectedClient: GatewayBrowserClient | null = null;
  let profileId: string | undefined;
  let lastAccess: WebPushAccess | null = null;
  let generation = 0;
  let disposed = false;
  let retireRead = () => {};
  const reconcile = (client: GatewayBrowserClient, currentGeneration: number, queued = false) => {
    retireRead();
    const completion = Promise.withResolvers<void>();
    retireRead = completion.resolve;
    const current = () => !disposed && currentGeneration === generation;
    const publish = (patch: WebPushCapabilityPatch) => {
      if (current()) {
        params.publish(patch);
      }
    };
    const run = async () => {
      if (!current()) {
        return;
      }
      try {
        publish(
          await reconcileWebPushCapability(
            webPushClient(params.gateway, client),
            readWebPushAccess(params.gateway.snapshot).canManage,
            publish,
          ),
        );
        completion.resolve();
      } catch (error) {
        if (current()) {
          completion.reject(error);
        } else {
          completion.resolve();
        }
      }
    };
    // The receipt describes admitted work even while the bootstrap queue holds it.
    void completion.promise.catch(() => {});
    publish({ read: completion.promise });
    void (queued && params.connectionBootstrap
      ? params.connectionBootstrap.run("web-push-reconcile", run)
      : run());
  };
  const handleGateway = (snapshot: ApplicationGateway["snapshot"]) => {
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const access = readWebPushAccess(snapshot);
    if (
      client === connectedClient &&
      snapshot.selfUser?.id === profileId &&
      access.canManage === lastAccess?.canManage &&
      access.canReadPreferences === lastAccess?.canReadPreferences
    ) {
      return;
    }
    const clientChanged = client !== connectedClient;
    connectedClient = client;
    profileId = snapshot.selfUser?.id;
    lastAccess = access;
    const currentGeneration = ++generation;
    retireRead();
    params.publish({ subscription: "unknown", preferences: null, error: null, read: undefined });
    if (client) {
      reconcile(client, currentGeneration, clientChanged);
    }
  };
  // Connection receipts invalidate prior registration work before reconciling the new client.
  const stopGateway = params.gateway.subscribe(handleGateway);
  const stopEvents = params.gateway.subscribeEvents((event) => {
    const payload = event.payload;
    const client = params.gateway.snapshot.client;
    if (
      event.event !== "users.prefs.changed" ||
      !client ||
      !readWebPushAccess(params.gateway.snapshot).canReadPreferences ||
      !payload ||
      typeof payload !== "object" ||
      !params.gateway.snapshot.selfUser?.id ||
      !("keys" in payload) ||
      !Array.isArray(payload.keys) ||
      !payload.keys.includes(WEB_PUSH_USER_PREFERENCES_KEY)
    ) {
      return;
    }
    reconcile(client, ++generation);
  });
  handleGateway(params.gateway.snapshot);
  const retire = () => {
    generation += 1;
    retireRead();
  };
  return {
    retire,
    dispose() {
      disposed = true;
      retire();
      stopGateway();
      stopEvents();
    },
  };
}

export function createWebPushCapabilityRuntime(params: {
  connectionBootstrap?: ConnectionBootstrapCoordinator;
  gateway: ApplicationGateway;
  publish: (patch: WebPushCapabilityPatch) => void;
}): WebPushCapabilityRuntime {
  let operation: Promise<void> | null = null;
  let scope = params.gateway.snapshot;
  let retired = Promise.withResolvers<void>();
  let disposed = false;
  const stopScope = params.gateway.subscribe((next) => {
    const access = readWebPushAccess(next);
    const previous = readWebPushAccess(scope);
    if (
      next.client === scope.client &&
      next.phase === scope.phase &&
      next.selfUser?.id === scope.selfUser?.id &&
      access.canManage === previous.canManage &&
      access.canReadPreferences === previous.canReadPreferences
    ) {
      return;
    }
    retired.resolve();
    retired = Promise.withResolvers<void>();
    scope = next;
    params.publish({ command: undefined });
  });
  const reconciliation = startWebPushReconciliation(params);
  return {
    get pending() {
      return operation !== null;
    },
    run(action) {
      const client = params.gateway.snapshot.client;
      if (!client || disposed) {
        return Promise.resolve();
      }
      const admitted = retired;
      const isCurrent = () => !disposed && admitted === retired;
      const previous = operation;
      // This command's readback supersedes any earlier passive reconciliation.
      reconciliation.retire();
      const actionRun = (previous?.catch(() => {}) ?? Promise.resolve())
        .then(async () => {
          if (!isCurrent()) {
            return;
          }
          params.publish({ command: undefined });
          const patch = await runWebPushCapabilityAction(
            webPushClient(params.gateway, client),
            action,
          );
          if (isCurrent()) {
            params.publish(patch);
          }
        })
        .catch((error: unknown) => {
          if (isCurrent()) {
            throw error;
          }
        });
      const next = actionRun.finally(() => {
        if (operation === next) {
          operation = null;
          params.publish({
            permission: "Notification" in window ? Notification.permission : "unsupported",
          });
        }
      });
      operation = next;
      params.publish({ command: undefined, read: undefined, error: null });
      const completion = Promise.race([next, admitted.promise]);
      void completion.catch(() => {
        if (isCurrent()) {
          params.publish({ command: completion });
        }
      });
      return completion;
    },
    dispose() {
      disposed = true;
      retired.resolve();
      stopScope();
      reconciliation.dispose();
    },
  };
}

export async function subscribeToWebPush(
  client: Pick<GatewayBrowserClient, "request">,
  assertCanManage: () => void,
): Promise<WebPushReconcileResult> {
  assertCanManage();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}`);
  }

  const registration = await raceWithTimeout(
    () => navigator.serviceWorker.ready,
    SW_READY_TIMEOUT,
    () => {
      throw new Error("Service worker not ready (timed out)");
    },
  );
  const pushManager = requirePushManager(registration);
  const vapidPublicKey = await resolveGatewayVapidPublicKey(client);
  const existingSubscription = await pushManager.getSubscription();
  if (existingSubscription) {
    return await registerPushSubscription(client, existingSubscription, vapidPublicKey);
  }
  // This browser API creates a push subscription; it does not observe rendering state.
  assertCanManage();
  const pushSubscription = await pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey.buffer as ArrayBuffer,
  });

  try {
    return await registerPushSubscription(client, pushSubscription, vapidPublicKey);
  } catch (error) {
    try {
      await pushSubscription.unsubscribe();
    } catch {
      // The Gateway error remains the actionable failure.
    }
    throw error;
  }
}

export async function unsubscribeFromWebPush(
  client: Pick<GatewayBrowserClient, "request">,
): Promise<void> {
  const subscription = await getExistingSubscription();
  if (!subscription) {
    return;
  }
  try {
    await client.request("push.web.unsubscribe", {
      endpoint: subscription.endpoint,
    });
  } catch {
    // Local unsubscribe still prevents a stale browser subscription.
  }
  await subscription.unsubscribe();
}

async function requireExistingSubscription(): Promise<PushSubscription> {
  const subscription = await getExistingSubscription();
  if (!subscription) {
    throw new Error("Enable notifications before changing notification preferences.");
  }
  return subscription;
}

async function getWebPushPreferences(client: WebPushClient): Promise<WebPushPreferencesResult> {
  const subscription = await requireExistingSubscription();
  return await client.request<WebPushPreferencesResult>("push.web.preferences.get", {
    endpoint: subscription.endpoint,
  });
}

async function runWebPushCapabilityAction(
  client: WebPushClient,
  action: WebPushCapabilityAction,
): Promise<WebPushCapabilityPatch> {
  switch (action.kind) {
    case "enable":
      return await resolveWebPushCapabilityPatch(
        client,
        await subscribeToWebPush(client, client.assertCanManage),
      );
    case "disable":
      await unsubscribeFromWebPush(client);
      return { subscription: "missing", preferences: null };
    case "test":
      await client.request("push.web.test", {});
      return {};
    case "set": {
      client.assertCanManage();
      const subscription = await requireExistingSubscription();
      await client.request("push.web.preferences.set", {
        endpoint: subscription.endpoint,
        scope: action.scope,
        preferences: action.preferences,
      });
      return { preferences: await getWebPushPreferences(client) };
    }
    default:
      return action satisfies never;
  }
}
