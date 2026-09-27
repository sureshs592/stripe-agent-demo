import type { GmailMessage } from "./gmail";

export type StripeAction = {
  operationId: string;
  parameters: Record<string, unknown>;
};

const PAYMENT_INTENT_ID = /\bpi_[a-zA-Z0-9]+\b/;

// Deterministic subject/body matching. Add more rules here as new email
// patterns need to trigger Stripe actions.
export function matchRule(message: GmailMessage): StripeAction | null {
  const text = `${message.subject}\n${message.snippet}`;

  if (/refund/i.test(message.subject)) {
    const match = text.match(PAYMENT_INTENT_ID);
    if (match) {
      return {
        operationId: "PostRefunds",
        parameters: { payment_intent: match[0] },
      };
    }
  }

  return null;
}
