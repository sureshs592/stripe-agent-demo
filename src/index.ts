import { getAgentByName } from "agents";
import { createHash, timingSafeEqual } from "node:crypto";
import { EmailStripeAgent } from "./agent";
import { ThreadStore } from "./thread-store";

export { EmailStripeAgent, ThreadStore };

type ThreadMessage = { threadId: string };

function constantTimeEqual(a: string, b: string): boolean {
  // Hash both sides first so the buffers compared are always the same length
  // (32 bytes), otherwise timingSafeEqual throws on a length mismatch.
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  return (
    constantTimeEqual(username, env.RUN_AUTH_USERNAME) &&
    constantTimeEqual(password, env.RUN_AUTH_PASSWORD)
  );
}

const STORE_NAME = "default";
const AGENT_NAME = "default";

function getStore(env: Env) {
  return env.ThreadStore.get(env.ThreadStore.idFromName(STORE_NAME));
}
const CONFIG_KEYS = ["google_refresh_token", "polling_enabled"];

// Poll Gmail, record unseen threads as "enqueued", and put them on the queue.
async function pollAndEnqueue(env: Env): Promise<string[]> {
  const store = getStore(env);
  const threadIds = await store.discoverNewThreads();
  if (threadIds.length > 0) {
    try {
      await env.THREAD_QUEUE.sendBatch(threadIds.map((threadId) => ({ body: { threadId } })));
    } catch (error) {
      await store.releaseThreads(threadIds);
      console.error("Poll failed to enqueue threads", JSON.stringify({ threadIds }), error);
      throw error;
    }
  }
  return threadIds;
}

const POLL_INTERVAL_MS = 5_000;
// No new poll starts at or after this offset, so a 5s cadence runs polls at
// 0, 5, ... 50s and the invocation ends well before the next cron tick.
const POLL_WINDOW_MS = 55_000;

// Cron fires once a minute; poll every 5s within that minute. Overlap with the
// next invocation is harmless: discoverNewThreads is atomic inside the Durable
// Object (no awaits between its SELECT and INSERT), so a thread can't be
// enqueued twice.
async function scheduledPollLoop(env: Env): Promise<void> {
  const store = getStore(env);
  const startedAt = Date.now();

  for (let tick = 0; ; tick++) {
    // Re-checked every tick so flipping the flag stops the loop promptly.
    if (!(await store.isPollingEnabled())) {
      console.log("Poll skipped: polling_enabled is not 'true' in app_config");
      return;
    }

    try {
      await pollAndEnqueue(env);
    } catch (error) {
      // pollAndEnqueue only throws on failure; keep looping for the next tick.
      console.error("Poll tick failed", error);
    }

    const nextTickAt = startedAt + (tick + 1) * POLL_INTERVAL_MS;
    if (nextTickAt - startedAt >= POLL_WINDOW_MS) return;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextTickAt - Date.now())));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    const isRun = url.pathname === "/run" && request.method === "POST";
    const isAppConfig = url.pathname === "/app-config";
    const isGetConfig = isAppConfig && request.method === "GET";
    const isSetConfig = isAppConfig && request.method === "PUT";

    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="stripe-agent-demo"' },
      });
    }

    if (isGetConfig) {
      return Response.json(await getStore(env).getConfig());
    }

    if (isSetConfig) {
      let body: { key?: unknown; value?: unknown };
      try {
        body = await request.json();
      } catch {
        return new Response('Body must be JSON: {"key": "...", "value": "..."}', { status: 400 });
      }
      const { key, value } = body;
      if (typeof key !== "string" || typeof value !== "string" || !value.trim()) {
        return new Response("key and value must be non-empty strings", { status: 400 });
      }
      if (!CONFIG_KEYS.includes(key)) {
        return new Response(`Unknown key. Allowed: ${CONFIG_KEYS.join(", ")}`, { status: 400 });
      }
      await getStore(env).setConfig(key, value.trim());
      return new Response("OK");
    }

    if (url.pathname === "/processed-threads") {
      if (request.method === "GET") {
        return Response.json(await getStore(env).listThreads());
      }
      if (request.method === "DELETE") {
        return Response.json({ deleted: await getStore(env).clearThreads() });
      }
    }

    if (isRun) {
      // Manual trigger for the same poll the cron runs.
      return Response.json({ enqueued: await pollAndEnqueue(env) });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduledPollLoop(env));
  },

  // Queue worker: one thread per invocation. No retries are configured because
  // re-running an agent that may already have initiated a payment is unsafe;
  // failures are recorded as state "failed" in the threads table.
  async queue(batch: MessageBatch<ThreadMessage>, env: Env) {
    const store = getStore(env);
    for (const message of batch.messages) {
      const { threadId } = message.body;
      try {
        if (await store.claimThread(threadId)) {
          // Only here is the agent (and its Stripe MCP connection) woken.
          try {
            const agent = await getAgentByName(env.EmailStripeAgent, AGENT_NAME);
            await agent.processThread(threadId, await store.getRefreshToken());
            await store.finishThread(threadId, "processed");
          } catch (error) {
            await store.finishThread(threadId, "failed");
            throw error;
          }
        }
      } catch (error) {
        console.error("Thread processing failed", threadId, error);
      }
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, ThreadMessage>;
