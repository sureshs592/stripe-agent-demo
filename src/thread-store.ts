import { DurableObject } from "cloudflare:workers";
import { listLabeledThreadIds } from "./gmail";

export type ThreadState = "enqueued" | "in_progress" | "processed" | "failed";

// Config, thread bookkeeping and Gmail polling live here rather than on
// EmailStripeAgent: that class connects to the Stripe MCP server whenever it
// wakes, which polling and config reads never need.
//
// Config (refresh token, polling flag) lives in this DO's SQLite storage so it
// can be edited out-of-band (dashboard Data Studio, or PUT /app-config).
// It is re-read on every use, so edits apply without a restart or redeploy.
export class ThreadStore extends DurableObject<Env> {
  private sql<T extends Record<string, SqlStorageValue>>(strings: TemplateStringsArray, ...values: SqlStorageValue[]): T[] {
    return [...this.ctx.storage.sql.exec<T>(strings.join("?"), ...values)];
  }

  private ensureConfigTable() {
    this.sql`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    // Polling starts disabled; flip to 'true' (Data Studio) to enable the cron poll.
    this.sql`INSERT OR IGNORE INTO app_config (key, value) VALUES ('polling_enabled', 'false')`;
  }

  private ensureThreadsTable() {
    this.sql`CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;
  }

  async isPollingEnabled(): Promise<boolean> {
    this.ensureConfigTable();
    const [row] = this.sql<{ value: string }>`SELECT value FROM app_config WHERE key = 'polling_enabled'`;
    return row?.value.trim().toLowerCase() === "true";
  }

  async getRefreshToken(): Promise<string> {
    this.ensureConfigTable();
    const [row] = this.sql<{ value: string }>`SELECT value FROM app_config WHERE key = 'google_refresh_token'`;
    if (!row?.value) {
      throw new Error("Google refresh token not set in app_config (key: google_refresh_token)");
    }
    return row.value;
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

  async listThreads(): Promise<{ thread_id: string; state: ThreadState; updated_at: string }[]> {
    this.ensureThreadsTable();
    return this.sql<{ thread_id: string; state: ThreadState; updated_at: string }>`SELECT thread_id, state, updated_at FROM threads ORDER BY updated_at DESC`;
  }

  // Returns the number of rows removed.
  async clearThreads(): Promise<number> {
    this.ensureThreadsTable();
    const cursor = this.ctx.storage.sql.exec("DELETE FROM threads");
    return cursor.rowsWritten;
  }

  // Polls Gmail for labeled threads and records any not yet seen as "enqueued".
  // Returns only the newly inserted thread IDs; the caller is responsible for
  // putting them on the queue (and calling releaseThreads if that fails).
  async discoverNewThreads(): Promise<string[]> {
    this.ensureThreadsTable();
    const threadIds = await listLabeledThreadIds(this.env, await this.getRefreshToken(), 20);
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

  // Atomically moves an "enqueued" thread to "in_progress". Queue delivery is
  // at-least-once, and re-running a thread that is already in_progress (or
  // done) could pay a bill twice, so only a true return means "you may run it".
  async claimThread(threadId: string): Promise<boolean> {
    this.ensureThreadsTable();
    const [row] = this.sql<{ state: ThreadState }>`SELECT state FROM threads WHERE thread_id = ${threadId}`;
    if (row?.state !== "enqueued") {
      console.warn("Skipping thread not in enqueued state", JSON.stringify({ threadId, state: row?.state ?? "unknown" }));
      return false;
    }
    this.setThreadState(threadId, "in_progress");
    return true;
  }

  async finishThread(threadId: string, state: "processed" | "failed"): Promise<void> {
    this.setThreadState(threadId, state);
  }

  private setThreadState(threadId: string, state: ThreadState) {
    this.ensureThreadsTable();
    this.sql`UPDATE threads SET state = ${state}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE thread_id = ${threadId}`;
  }
}
