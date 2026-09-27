export type GmailMessage = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
};

type TokenResponse = {
  access_token: string;
};

async function getAccessToken(env: Env): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${await response.text()}`);
  }

  const token = (await response.json()) as TokenResponse;
  return token.access_token;
}

type GmailListResponse = {
  messages?: { id: string }[];
};

type GmailMessageResource = {
  id: string;
  snippet: string;
  internalDate: string;
  payload: {
    headers: { name: string; value: string }[];
  };
};

function headerValue(message: GmailMessageResource, name: string): string {
  return message.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function searchGmail(env: Env): Promise<GmailMessage[]> {
  const accessToken = await getAccessToken(env);
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", `label:${env.GMAIL_LABEL}`);
  listUrl.searchParams.set("maxResults", "20");

  const listResponse = await fetch(listUrl, { headers: authHeaders });
  if (!listResponse.ok) {
    throw new Error(`Gmail list failed: ${listResponse.status} ${await listResponse.text()}`);
  }
  const { messages = [] } = (await listResponse.json()) as GmailListResponse;

  return Promise.all(
    messages.map(async ({ id }) => {
      const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      messageUrl.searchParams.set("format", "metadata");
      messageUrl.searchParams.append("metadataHeaders", "From");
      messageUrl.searchParams.append("metadataHeaders", "Subject");

      const messageResponse = await fetch(messageUrl, { headers: authHeaders });
      if (!messageResponse.ok) {
        throw new Error(`Gmail get message ${id} failed: ${messageResponse.status} ${await messageResponse.text()}`);
      }
      const message = (await messageResponse.json()) as GmailMessageResource;

      return {
        id: message.id,
        from: headerValue(message, "From"),
        subject: headerValue(message, "Subject"),
        snippet: message.snippet,
        receivedAt: new Date(Number(message.internalDate)).toISOString(),
      };
    })
  );
}
