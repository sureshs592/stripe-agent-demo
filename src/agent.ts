import { Agent } from "agents";
import { generateText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getThreadMessages, listLabeledThreadIds, markThreadProcessed } from "./gmail";
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

type ThreadState = "enqueued" | "in_progress" | "processed" | "failed";

type State = {
  lastRunAt: string | null;
  lastRunResult: RunResult | null;
};

export class EmailStripeAgent extends Agent<Env, State> {
  initialState: State = { lastRunAt: null, lastRunResult: null };

  // Config (refresh token, polling flag) lives in the DO's SQLite storage so it
  // can be edited out-of-band (dashboard Data Studio, or PUT /app-config).
  // It is re-read on every use, so edits apply without a restart or redeploy.
  private ensureConfigTable() {
    this.sql`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    // Polling starts disabled; flip to 'true' (Data Studio) to enable the cron poll.
    this.sql`INSERT OR IGNORE INTO app_config (key, value) VALUES ('polling_enabled', 'false')`;
  }

  async isPollingEnabled(): Promise<boolean> {
    this.ensureConfigTable();
    const [row] = this.sql<{ value: string }>`SELECT value FROM app_config WHERE key = 'polling_enabled'`;
    return row?.value.trim().toLowerCase() === "true";
  }

  private getRefreshToken(): string {
    this.ensureConfigTable();
    const [row] = this.sql<{ value: string }>`SELECT value FROM app_config WHERE key = 'google_refresh_token'`;
    if (!row?.value) {
      throw new Error("Google refresh token not set in app_config (key: google_refresh_token)");
    }
    return row.value;
  }

  private ensureThreadsTable() {
    this.sql`CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;
  }

  private setThreadState(threadId: string, state: ThreadState) {
    this.ensureThreadsTable();
    this.sql`UPDATE threads SET state = ${state}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE thread_id = ${threadId}`;
  }

  // Polls Gmail for labeled threads and records any not yet seen as "enqueued".
  // Returns only the newly inserted thread IDs; the caller is responsible for
  // putting them on the queue (and calling releaseThreads if that fails).
  async discoverNewThreads(): Promise<string[]> {
    this.ensureThreadsTable();
    const threadIds = await listLabeledThreadIds(this.env, this.getRefreshToken(), 20);
    const fresh: string[] = [];
    for (const threadId of threadIds) {
      const [existing] = this.sql<{ thread_id: string }>`SELECT thread_id FROM threads WHERE thread_id = ${threadId}`;
      if (existing) continue;
      this.sql`INSERT INTO threads (thread_id, state) VALUES (${threadId}, 'enqueued')`;
      fresh.push(threadId);
    }
    return fresh;
  }

  // Undo discoverNewThreads for threads that never made it onto the queue, so
  // the next poll picks them up again.
  async releaseThreads(threadIds: string[]): Promise<void> {
    this.ensureThreadsTable();
    for (const threadId of threadIds) {
      this.sql`DELETE FROM threads WHERE thread_id = ${threadId} AND state = 'enqueued'`;
    }
  }

  async getConfig(): Promise<Record<string, string>> {
    this.ensureConfigTable();
    const rows = this.sql<{ key: string; value: string }>`SELECT key, value FROM app_config ORDER BY key`;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.ensureConfigTable();
    this.sql`INSERT INTO app_config (key, value) VALUES (${key}, ${value})
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

  // Queue consumer entry point. Only an "enqueued" thread is picked up: queue
  // delivery is at-least-once, and re-running a thread that is already
  // in_progress (or done) could pay a bill twice.
  async processThread(threadId: string): Promise<RunResult | null> {
    this.ensureThreadsTable();
    const [row] = this.sql<{ state: ThreadState }>`SELECT state FROM threads WHERE thread_id = ${threadId}`;
    if (row?.state !== "enqueued") {
      console.warn("Skipping thread not in enqueued state", JSON.stringify({ threadId, state: row?.state ?? "unknown" }));
      return null;
    }

    this.setThreadState(threadId, "in_progress");
    try {
      const result = await this.runAgent(threadId);
      this.setThreadState(threadId, "processed");
      return result;
    } catch (error) {
      this.setThreadState(threadId, "failed");
      throw error;
    }
  }

  private async runAgent(threadId: string): Promise<RunResult> {
    await this.requireStripeTools();
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    const tools = {
      get_thread: tool({
        description: "Fetch the messages in the email thread being processed. Returns each message's id, threadId, sender, subject, snippet, body, and received timestamp.",
        inputSchema: z.object({}),
        execute: async () => getThreadMessages(this.env, this.getRefreshToken(), threadId),
      }),
      mark_thread_processed: tool({
        description: "Apply the \"processed\" Gmail label to a thread once its bill has been paid, so it won't be picked up on the next run.",
        inputSchema: z.object({ threadId: z.string() }),
        execute: async ({ threadId }) => {
          await markThreadProcessed(this.env, this.getRefreshToken(), threadId);
          return { threadId, processed: true };
        },
      }),
      ...this.mcp.getAITools(),
    };

    const { text, toolCalls, toolResults } = await generateText({
      model: anthropic("claude-sonnet-5"),
      system: skillPrompt,
      prompt: `Process the email thread ${threadId} and pay any bills in it that are ready to be paid now.`,
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
