import { Agent } from "agents";
import { generateText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { markThreadProcessed, searchGmail } from "./gmail";
import skillPrompt from "../skills/pay-bills.md";

const STRIPE_MCP_URL = "https://mcp.stripe.com";
const STRIPE_MCP_NAME = "stripe";
const MCP_READY_TIMEOUT_MS = 15_000;
const MCP_READY_POLL_MS = 250;

type ToolCallLog = {
  tool: string;
  input: unknown;
  output?: unknown;
};

type RunResult = {
  summary: string;
  toolCalls: ToolCallLog[];
};

type State = {
  lastRunAt: string | null;
  lastRunResult: RunResult | null;
};

export class EmailStripeAgent extends Agent<Env, State> {
  initialState: State = { lastRunAt: null, lastRunResult: null };

  // The refresh token lives in the DO's SQLite storage so it can be edited
  // out-of-band (dashboard Data Studio, or PUT /admin/google-refresh-token).
  // It is re-read on every use, so edits apply without a restart or redeploy.
  private ensureConfigTable() {
    this.sql`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  }

  private getRefreshToken(): string {
    this.ensureConfigTable();
    const [row] = this.sql<{ value: string }>`SELECT value FROM app_config WHERE key = 'google_refresh_token'`;
    if (!row?.value) {
      throw new Error("Google refresh token not set in app_config (key: google_refresh_token)");
    }
    return row.value;
  }

  private ensureProcessedThreadsTable() {
    this.sql`CREATE TABLE IF NOT EXISTS processed_threads (
      thread_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;
  }

  private recordProcessedThread(threadId: string) {
    this.ensureProcessedThreadsTable();
    this.sql`INSERT OR IGNORE INTO processed_threads (thread_id) VALUES (${threadId})`;
  }

  async setRefreshToken(token: string): Promise<void> {
    this.ensureConfigTable();
    this.sql`INSERT INTO app_config (key, value) VALUES ('google_refresh_token', ${token})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  async onStart() {
    // callbackHost is only used to build an OAuth redirect URI; Stripe's MCP
    // server is authenticated with an API key below, so this value is never
    // actually used, but addMcpServer requires it when called outside a
    // request context (e.g. RPC via getAgentByName, as /run does).
    await this.addMcpServer(STRIPE_MCP_NAME, STRIPE_MCP_URL, "https://unused.invalid", undefined, {
      transport: {
        headers: { Authorization: `Bearer ${this.env.STRIPE_API_KEY}` },
      },
    });
  }

  // getAITools() is synchronous and returns whatever tools are cached, so an
  // agent woken cold can see an empty Stripe toolset. Wait for discovery, and
  // fail rather than run a money-moving flow without the Stripe tools.
  private async requireStripeTools(): Promise<void> {
    const snapshot = () => {
      const { servers, tools } = this.getMcpServers();
      const ids = Object.entries(servers)
        .filter(([, server]) => server.name === STRIPE_MCP_NAME)
        .map(([id]) => id);
      const states = ids.map((id) => servers[id].state);
      return {
        state: states.join(",") || "not-registered",
        // "ready" means discovery finished; "connected" alone can precede it,
        // and getAITools() warns about any connection not yet "ready".
        allReady: states.length > 0 && states.every((s) => s === "ready"),
        tools: tools.filter((t) => ids.includes(t.serverId)).map((t) => t.name),
      };
    };

    const isReady = (s: ReturnType<typeof snapshot>) => s.allReady && s.tools.length > 0;

    const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
    let current = snapshot();
    while (!isReady(current) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MCP_READY_POLL_MS));
      current = snapshot();
    }

    const ready = isReady(current);
    const log = { server: STRIPE_MCP_NAME, state: current.state, toolCount: current.tools.length, tools: current.tools };
    if (!ready) {
      console.error("Stripe MCP tools unavailable", JSON.stringify({ ...log, timeoutMs: MCP_READY_TIMEOUT_MS }));
      throw new Error(`Stripe MCP tools not available after ${MCP_READY_TIMEOUT_MS}ms (state: ${current.state})`);
    }
    console.log("Stripe MCP tools available", JSON.stringify(log));
  }

  async run(): Promise<RunResult> {
    await this.requireStripeTools();
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    const tools = {
      search_gmail: tool({
        description: `Search the Gmail inbox for messages under the "${this.env.GMAIL_LABEL}" label. Returns each message's id, threadId, sender, subject, snippet, body, and received timestamp.`,
        inputSchema: z.object({}),
        execute: async () => searchGmail(this.env, this.getRefreshToken()),
      }),
      mark_thread_processed: tool({
        description: "Apply the \"processed\" Gmail label to a thread once its bill has been paid, so it won't be picked up on the next run.",
        inputSchema: z.object({ threadId: z.string() }),
        execute: async ({ threadId }) => {
          await markThreadProcessed(this.env, this.getRefreshToken(), threadId);
          this.recordProcessedThread(threadId);
          return { threadId, processed: true };
        },
      }),
      ...this.mcp.getAITools(),
    };

    const { text, toolCalls, toolResults } = await generateText({
      model: anthropic("claude-sonnet-5"),
      system: skillPrompt,
      prompt: "Check the inbox and pay any bills that are ready to be paid now.",
      tools,
      stopWhen: stepCountIs(20),
    });

    const outputByCallId = new Map(toolResults.map((result) => [result.toolCallId, result.output]));
    const loggedToolCalls: ToolCallLog[] = toolCalls.map((call) => ({
      tool: call.toolName,
      input: call.input,
      output: outputByCallId.get(call.toolCallId),
    }));

    const result: RunResult = { summary: text, toolCalls: loggedToolCalls };
    this.setState({ lastRunAt: new Date().toISOString(), lastRunResult: result });
    return result;
  }
}
