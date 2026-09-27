import { routeAgentRequest, getAgentByName } from "agents";
import { EmailStripeAgent } from "./agent";

export { EmailStripeAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      const agent = await getAgentByName(env.EmailStripeAgent, "default");
      const results = await agent.run();
      return Response.json({ results });
    }

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
