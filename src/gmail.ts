export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
  receivedAt: string;
  pdfAttachments: GmailPdfAttachment[];
};

export type GmailPdfAttachment = {
  attachmentId: string;
  filename: string;
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
  filename?: string;
  body?: { data?: string; attachmentId?: string };
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

function isPdfPart(part: GmailMessagePart): boolean {
  return (
    !!part.body?.attachmentId &&
    (part.mimeType === "application/pdf" || (part.filename ?? "").toLowerCase().endsWith(".pdf"))
  );
}

function collectPdfAttachments(part: GmailMessagePart): GmailPdfAttachment[] {
  const own = isPdfPart(part)
    ? [{ attachmentId: part.body!.attachmentId!, filename: part.filename || "attachment.pdf" }]
    : [];
  return [...own, ...(part.parts ?? []).flatMap(collectPdfAttachments)];
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
    pdfAttachments: collectPdfAttachments(message.payload),
  };
}

// Returns the distinct thread IDs of up to `maxResults` messages
// under the configured label.
export async function listLabeledThreadIds(env: Env, refreshToken: string, maxResults = 20): Promise<string[]> {
  const accessToken = await getAccessToken(env, refreshToken);

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", `label:${env.GMAIL_LABEL}`);
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

// Returns the attachment's bytes as standard base64.
export async function getAttachmentBase64(
  env: Env,
  refreshToken: string,
  messageId: string,
  attachmentId: string,
): Promise<string> {
  const accessToken = await getAccessToken(env, refreshToken);
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`Gmail get attachment failed: ${response.status} ${await response.text()}`);
  }
  const { data } = (await response.json()) as { data: string };
  return data.replace(/-/g, "+").replace(/_/g, "/");
}
