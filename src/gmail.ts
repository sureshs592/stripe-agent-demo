export type GmailMessage = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
};

// TODO: replace with real Gmail API calls once OAuth is wired up
// (list/search https://gmail.googleapis.com/gmail/v1/users/me/messages using a
// refresh token stored as a secret, then fetch each message for subject/snippet).
export async function searchGmail(env: Env): Promise<GmailMessage[]> {
  return [
    {
      id: "mock-1",
      from: "customer@example.com",
      subject: "Refund request for order #1234",
      snippet: "Please refund my payment pi_3P0000000000000000000000, it never shipped.",
      receivedAt: new Date().toISOString(),
    },
  ];
}
