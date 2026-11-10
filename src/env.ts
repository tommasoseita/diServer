export interface Env {
  DB: D1Database;
  /** Encrypts keys at rest and proves who owns the server (setup). Required: this one or DIVOICE_SECRET. */
  SERVER_SECRET?: string;
  /** The same, under the name used by deployments made before diMail. */
  DIVOICE_SECRET?: string;
  /** Builds served by this server (pilots): "updates/<file>" for Sparkle, "updates/diVoice.dmg" for invites. */
  UPDATES?: KVNamespace;
  /** Provider keys set as Worker secrets, used when the admin hasn't saved one in the app. */
  MISTRAL_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  /** Provider endpoints (tests, or Mistral's EU endpoint https://api.eu.mistral.ai). */
  MISTRAL_BASE_URL?: string;
  OPENAI_BASE_URL?: string;
  ELEVENLABS_BASE_URL?: string;
  /** Where "Download diVoice" goes when the server hosts no build. */
  DOWNLOAD_URL?: string;
  /** Where "Download diMail" goes (default: the latest diMail release on GitHub). */
  DIMAIL_DOWNLOAD_URL?: string;
  /** The organization's name until the admin sets one. */
  ORG_NAME?: string;
}

export type Role = "member" | "admin";

/** The apps that use this server. */
export type App = "divoice" | "dimail";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export const DEFAULT_DIMAIL_DOWNLOAD_URL = "https://github.com/tommasoseita/diMail/releases/latest/download/diMail.dmg";

export const DEFAULT_DOWNLOAD_URL = "https://github.com/tommasoseita/divoice/releases/latest/download/diVoice.dmg";
