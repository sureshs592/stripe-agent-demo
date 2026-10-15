declare global {
  interface Env {
    STRIPE_API_KEY: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GMAIL_LABEL: string;
    ANTHROPIC_API_KEY: string;
    RUN_AUTH_USERNAME: string;
    RUN_AUTH_PASSWORD: string;
    THREAD_QUEUE: Queue<{ threadId: string }>;
  }
}

export {};
