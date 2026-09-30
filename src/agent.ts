import { Agent } from "agents";
import { generateText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { markThreadProcessed, searchGmail } from "./gmail";
import skillPrompt from "../skills/pay-bills.md";

const STRIPE_MCP_URL = "https://mcp.stripe.com";

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

  async onStart() {
    // callbackHost is only used to build an OAuth redirect URI; Stripe's MCP
    // server is authenticated with an API key below, so this value is never
    // actually used, but addMcpServer requires it when called outside a
    // request context (e.g. RPC via getAgentByName, as /run does).
    await this.addMcpServer("stripe", STRIPE_MCP_URL, "https://unused.invalid", undefined, {
      transport: {
        headers: { Authorization: `Bearer ${this.env.STRIPE_API_KEY}` },
      },
    });
  }

  async run(): Promise<RunResult> {
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    const tools = {
      search_gmail: tool({
        description: `Search the Gmail inbox for messages under the "${this.env.GMAIL_LABEL}" label. Returns each message's id, threadId, sender, subject, snippet, body, and received timestamp.`,
        inputSchema: z.object({}),
        execute: async () => searchGmail(this.env),
      }),
      mark_thread_processed: tool({
        description: "Apply the \"processed\" Gmail label to a thread once its bill has been paid, so it won't be picked up on the next run.",
        inputSchema: z.object({ threadId: z.string() }),
        execute: async ({ threadId }) => {
          await markThreadProcessed(this.env, threadId);
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
