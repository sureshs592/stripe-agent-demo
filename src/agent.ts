import { Agent } from "agents";
import { searchGmail } from "./gmail";
import { matchRule } from "./rules";

const STRIPE_MCP_URL = "https://mcp.stripe.com";

type RunResult = {
  messageId: string;
  subject: string;
  action: string | null;
  status: "matched" | "no_match" | "error";
  detail?: string;
};

type State = {
  lastRunAt: string | null;
  lastRunResults: RunResult[];
};

export class EmailStripeAgent extends Agent<Env, State> {
  initialState: State = { lastRunAt: null, lastRunResults: [] };

  private stripeServerId?: string;

  async onStart() {
    // callbackHost is only used to build an OAuth redirect URI; Stripe's MCP
    // server is authenticated with an API key below, so this value is never
    // actually used, but addMcpServer requires it when called outside a
    // request context (e.g. RPC via getAgentByName, as /run does).
    const connection = await this.addMcpServer(
      "stripe",
      STRIPE_MCP_URL,
      "https://unused.invalid",
      undefined,
      {
        transport: {
          headers: { Authorization: `Bearer ${this.env.STRIPE_API_KEY}` },
        },
      }
    );
    this.stripeServerId = connection.id;
  }

  async run(): Promise<RunResult[]> {
    const messages = await searchGmail(this.env);
    const results: RunResult[] = [];

    for (const message of messages) {
      const rule = matchRule(message);
      if (!rule) {
        results.push({
          messageId: message.id,
          subject: message.subject,
          action: null,
          status: "no_match",
        });
        continue;
      }

      try {
        await this.callStripeTool(rule.operationId, rule.parameters);
        results.push({
          messageId: message.id,
          subject: message.subject,
          action: rule.operationId,
          status: "matched",
        });
      } catch (err) {
        results.push({
          messageId: message.id,
          subject: message.subject,
          action: rule.operationId,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.setState({ lastRunAt: new Date().toISOString(), lastRunResults: results });
    return results;
  }

  private async callStripeTool(operationId: string, parameters: Record<string, unknown>) {
    if (!this.stripeServerId) {
      throw new Error("Stripe MCP server is not connected");
    }
    const connection = this.mcp.mcpConnections[this.stripeServerId];
    if (!connection) {
      throw new Error("Stripe MCP connection missing");
    }

    return connection.client.callTool({
      name: "stripe_api_write",
      arguments: { stripe_api_operation_id: operationId, parameters },
    });
  }
}
