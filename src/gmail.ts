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

async function getAccessToken(env: Env, refreshToken: string): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
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
  messages?: { id: string; threadId: string }[];
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

function toGmailMessage(message: GmailMessageResource): GmailMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    from: headerValue(message, "From"),
    subject: headerValue(message, "Subject"),
    snippet: message.snippet,
    body: extractPlainTextBody(message.payload),
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
  };
}

// Returns the distinct thread IDs of up to `maxResults` unprocessed messages
// under the configured label.
export async function listLabeledThreadIds(env: Env, refreshToken: string, maxResults = 20): Promise<string[]> {
  const accessToken = await getAccessToken(env, refreshToken);

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", `label:${env.GMAIL_LABEL} -label:${PROCESSED_LABEL_NAME}`);
  listUrl.searchParams.set("maxResults", String(maxResults));

  const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listResponse.ok) {
    throw new Error(`Gmail list failed: ${listResponse.status} ${await listResponse.text()}`);
  }
  const { messages = [] } = (await listResponse.json()) as GmailListResponse;
  return [...new Set(messages.map((m) => m.threadId))];
}

export async function getThreadMessages(env: Env, refreshToken: string, threadId: string): Promise<GmailMessage[]> {
  const accessToken = await getAccessToken(env, refreshToken);

  const threadUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`);
  threadUrl.searchParams.set("format", "full");

  const response = await fetch(threadUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    throw new Error(`Gmail get thread ${threadId} failed: ${response.status} ${await response.text()}`);
  }
  const { messages = [] } = (await response.json()) as { messages?: GmailMessageResource[] };
  return messages.map(toGmailMessage);
}

export async function markThreadProcessed(env: Env, refreshToken: string, threadId: string): Promise<void> {
  const accessToken = await getAccessToken(env, refreshToken);
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
