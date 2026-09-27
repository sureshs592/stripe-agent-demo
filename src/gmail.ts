export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
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

type GmailMessagePart = {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
};

type GmailMessageResource = GmailMessagePart & {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  payload: GmailMessagePart & {
    headers: { name: string; value: string }[];
  };
};

function headerValue(message: GmailMessageResource, name: string): string {
  return message.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const PROCESSED_LABEL_NAME = "processed";

type GmailLabel = { id: string; name: string };

type GmailLabelListResponse = { labels?: GmailLabel[] };

async function getOrCreateLabelId(accessToken: string, labelName: string): Promise<string> {
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const listResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: authHeaders,
  });
  if (!listResponse.ok) {
    throw new Error(`Gmail labels list failed: ${listResponse.status} ${await listResponse.text()}`);
  }
  const { labels = [] } = (await listResponse.json()) as GmailLabelListResponse;
  const existing = labels.find((label) => label.name === labelName);
  if (existing) {
    return existing.id;
  }

  const createResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`Gmail label create failed: ${createResponse.status} ${await createResponse.text()}`);
  }
  const created = (await createResponse.json()) as GmailLabel;
  return created.id;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function extractPlainTextBody(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = extractPlainTextBody(child);
    if (text) return text;
  }
  return "";
}

export async function searchGmail(env: Env): Promise<GmailMessage[]> {
  const accessToken = await getAccessToken(env);
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", `label:${env.GMAIL_LABEL} -label:${PROCESSED_LABEL_NAME}`);
  listUrl.searchParams.set("maxResults", "20");

  const listResponse = await fetch(listUrl, { headers: authHeaders });
  if (!listResponse.ok) {
    throw new Error(`Gmail list failed: ${listResponse.status} ${await listResponse.text()}`);
  }
  const { messages = [] } = (await listResponse.json()) as GmailListResponse;

  return Promise.all(
    messages.map(async ({ id }) => {
      const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
      messageUrl.searchParams.set("format", "full");

      const messageResponse = await fetch(messageUrl, { headers: authHeaders });
      if (!messageResponse.ok) {
        throw new Error(`Gmail get message ${id} failed: ${messageResponse.status} ${await messageResponse.text()}`);
      }
      const message = (await messageResponse.json()) as GmailMessageResource;

      return {
        id: message.id,
        threadId: message.threadId,
        from: headerValue(message, "From"),
        subject: headerValue(message, "Subject"),
        snippet: message.snippet,
        body: extractPlainTextBody(message.payload),
        receivedAt: new Date(Number(message.internalDate)).toISOString(),
      };
    })
  );
}

export async function markThreadProcessed(env: Env, threadId: string): Promise<void> {
  const accessToken = await getAccessToken(env);
  const labelId = await getOrCreateLabelId(accessToken, PROCESSED_LABEL_NAME);

  const modifyResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  if (!modifyResponse.ok) {
    throw new Error(`Gmail thread modify failed: ${modifyResponse.status} ${await modifyResponse.text()}`);
  }
}
