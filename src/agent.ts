import { Agent } from "agents";
import { generateText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getAttachmentBase64, getThreadMessages, markThreadProcessed } from "./gmail";
import skillPrompt from "../skills/pay-bills.md";

const STRIPE_MCP_URL = "https://mcp.stripe.com";
const STRIPE_MCP_NAME = "stripe";
const MCP_READY_TIMEOUT_MS = 15_000;
const MCP_READY_POLL_MS = 250;
const STRIPE_KEY_FINGERPRINT = "stripe_key_fingerprint";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

// Wraps each tool's execute so every call logs "<prefix>_<name>" and its input.
function withToolLogging<T extends Record<string, any>>(prefix: string, tools: T): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      if (typeof t.execute !== "function") return [name, t];
      const execute = t.execute;
      return [
        name,
        {
          ...t,
          execute: (input: unknown, options: unknown) => {
            console.log(`[${prefix}] tool call: ${name}`, JSON.stringify(input));
            return execute(input, options);
          },
        },
      ];
    }),
  ) as T;
}

export class EmailStripeAgent extends Agent<Env, State> {
  initialState: State = { lastRunAt: null, lastRunResult: null };

  // The SDK persists MCP registrations in this Durable Object's SQLite and, on
  // every wake, restores them and reconnects in the background *before* this
  // runs. addMcpServer is not idempotent (new id + new row each call), so we
  // only call it when there's nothing reusable. A restored connection reuses
  // the Authorization header saved with it, so we also store a hash of the API
  // key it was created with and re-register when the env key no longer matches.
  async onStart() {
    const fingerprint = await sha256Hex(this.env.STRIPE_API_KEY);
    const keyChanged = (await this.ctx.storage.get<string>(STRIPE_KEY_FINGERPRINT)) !== fingerprint;

    const registered = Object.entries(this.getMcpServers().servers).filter(
      ([, server]) => server.name === STRIPE_MCP_NAME,
    );
    // Keep at most one: the first that isn't stuck waiting on OAuth. Drop it
    // too if the key changed.
    const reusable = keyChanged ? undefined : registered.find(([, server]) => server.state !== "authenticating");
    for (const [id] of registered) {
      if (id !== reusable?.[0]) await this.removeMcpServer(id);
    }
    if (reusable) return;

    // callbackHost is only used to build an OAuth redirect URI; Stripe's MCP
    // server is authenticated with an API key, so it is never actually used,
    // but addMcpServer requires it outside a request context (e.g. RPC via
    // getAgentByName). This call connects and discovers tools before returning.
    const result = await this.addMcpServer(STRIPE_MCP_NAME, STRIPE_MCP_URL, "https://unused.invalid", undefined, {
      transport: {
        headers: { Authorization: `Bearer ${this.env.STRIPE_API_KEY}` },
      },
    });
    if (result.state === "authenticating") {
      throw new Error("Stripe MCP requested OAuth; check that STRIPE_API_KEY is set and valid");
    }
    await this.ctx.storage.put(STRIPE_KEY_FINGERPRINT, fingerprint);
  }

  // A reused (restored) connection reconnects in the background after wake, and
  // getAITools() is synchronous and returns only what's cached, so wait for the
  // Stripe server to be "ready" with tools, and fail rather than run a
  // money-moving flow without them.
  private async requireStripeTools(): Promise<void> {
    const snapshot = () => {
      const { servers, tools } = this.getMcpServers();
      const ids = Object.keys(servers).filter((id) => servers[id].name === STRIPE_MCP_NAME);
      const states = ids.map((id) => servers[id].state);
      return {
        state: states.join(",") || "not-registered",
        // "ready" means discovery finished; "connected" alone can precede it.
        ready: states.length === 1 && states[0] === "ready",
        tools: tools.filter((t) => ids.includes(t.serverId)).map((t) => t.name),
      };
    };

    const isReady = (s: ReturnType<typeof snapshot>) => s.ready && s.tools.length > 0;

    const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
    let current = snapshot();
    while (!isReady(current) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MCP_READY_POLL_MS));
      current = snapshot();
    }

    const log = { server: STRIPE_MCP_NAME, state: current.state, toolCount: current.tools.length, tools: current.tools };
    if (!isReady(current)) {
      console.error("Stripe MCP tools unavailable", JSON.stringify({ ...log, timeoutMs: MCP_READY_TIMEOUT_MS }));
      throw new Error(`Stripe MCP tools not available after ${MCP_READY_TIMEOUT_MS}ms (state: ${current.state})`);
    }
    console.log("Stripe MCP tools available", JSON.stringify(log));
  }

  // Queue consumer entry point. The caller (see index.ts) has already claimed
  // the thread via ThreadStore and supplies the Gmail refresh token, so this
  // class only runs the agentic piece.
  async processThread(threadId: string, refreshToken: string): Promise<RunResult> {
    return this.runAgent(threadId, refreshToken);
  }

  private async runAgent(threadId: string, refreshToken: string): Promise<RunResult> {
    await this.requireStripeTools();
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    const customTools = {
      get_thread: tool({
        description: "Fetch the messages in the email thread being processed. Returns each message's id, threadId, sender, subject, snippet, body, received timestamp, and a list of PDF attachments (attachmentId, filename).",
        inputSchema: z.object({}),
        execute: async () => getThreadMessages(this.env, refreshToken, threadId),
      }),
      get_pdf_attachment: tool({
        description: "Download a PDF attachment from a message in the thread being processed and return its contents so you can read it. Use the messageId and an attachmentId from get_thread.",
        inputSchema: z.object({ messageId: z.string(), attachmentId: z.string() }),
        // The messageId/attachmentId pair comes from get_thread and is trusted as-is.
        execute: async ({ messageId, attachmentId }) => ({
          base64: await getAttachmentBase64(this.env, refreshToken, messageId, attachmentId),
        }),
        // Hand the PDF to the model as a document rather than as a huge JSON string.
        toModelOutput: ({ output }) => ({
          type: "content",
          value: [
            { type: "file", mediaType: "application/pdf", data: { type: "data", data: output.base64 } },
          ],
        }),
      }),
      mark_thread_processed: tool({
        description: "Apply the \"processed\" Gmail label to a thread once its bill has been paid, so it won't be picked up on the next run.",
        inputSchema: z.object({ threadId: z.string() }),
        execute: async ({ threadId }) => {
          await markThreadProcessed(this.env, refreshToken, threadId);
          return { threadId, processed: true };
        },
      }),
    };
    // getAITools() needs the AI SDK's jsonSchema, which MCPClientManager only
    // lazy-loads in connect(). A server restored from SQLite after a wake skips
    // that path, so load it explicitly.
    await this.mcp.ensureJsonSchema();
    const loggedTools = {
      ...withToolLogging("custom", customTools),
      ...withToolLogging("stripe", this.mcp.getAITools()),
    };

    const { text, toolCalls, toolResults } = await generateText({
      model: anthropic("claude-sonnet-5"),
      system: skillPrompt,
      prompt: `Process the email thread ${threadId} and pay any bills in it that are ready to be paid now.`,
      tools: loggedTools,
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
