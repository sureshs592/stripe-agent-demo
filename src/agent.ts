import { Agent } from "agents";
import { generateText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getThreadMessages, markThreadProcessed } from "./gmail";
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
        description: "Fetch the messages in the email thread being processed. Returns each message's id, threadId, sender, subject, snippet, body, and received timestamp.",
        inputSchema: z.object({}),
        execute: async () => getThreadMessages(this.env, refreshToken, threadId),
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
