declare global {
  interface Env {
    STRIPE_API_KEY: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_REFRESH_TOKEN: string;
    GMAIL_LABEL: string;
    ANTHROPIC_API_KEY: string;
  }
}

export {};
