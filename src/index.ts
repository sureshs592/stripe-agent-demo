import { routeAgentRequest, getAgentByName } from "agents";
import { createHash, timingSafeEqual } from "node:crypto";
import { EmailStripeAgent } from "./agent";

export { EmailStripeAgent };

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="stripe-agent-demo"' },
        });
      }

      const agent = await getAgentByName(env.EmailStripeAgent, "default");
      const results = await agent.run();
      return Response.json({ results });
    }

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
