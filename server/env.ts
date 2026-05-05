import "dotenv/config";

/**
 * All env vars consumed by the server.  Fail-fast at boot if a required
 * variable is missing, rather than at the first DB call.
 *
 * Two-port convention:
 *   - SERVER_PORT (preferred per spec) or PORT (legacy, what Render/Railway
 *     inject) — both accepted, SERVER_PORT wins if both are set.
 *
 * Multi-origin CORS:
 *   - CLIENT_ORIGIN is now a comma-separated list.  Single-origin .env files
 *     keep working; production .env can list every public hostname.  When
 *     unset, defaults to the four origins the deployment spec calls out:
 *       https://pre-richard-tion.fun
 *       https://www.pre-richard-tion.fun
 *       http://localhost:5173
 *       http://localhost:5174
 *     This makes a default `git clone && npm run dev:server` Just Work for a
 *     local frontend on either Vite default port AND for the Netlify
 *     production hostname without any env wiring.
 */
export interface ServerEnv {
  PORT: number;
  /**
   * Allow-list of browser origins for CORS.  An incoming request with an
   * Origin header NOT in this list is rejected at the CORS layer.  Requests
   * without an Origin header (curl, server-to-server, native apps) bypass the
   * check — that's standard CORS semantics.
   */
  CLIENT_ORIGIN: string[];
  ADMIN_API_KEY: string;

  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  HELIUS_RPC_URL: string;
  TROLL_MINT: string;

  /** Base58 secret key bytes of the escrow authority (server-controlled). */
  ESCROW_AUTHORITY_SECRET: string;
  /** Optional override; otherwise derived as the ATA of (TROLL_MINT, ESCROW_AUTHORITY). */
  ESCROW_TOKEN_ACCOUNT_OVERRIDE: string | null;

  /** Confirmation level required when verifying deposit signatures. */
  DEPOSIT_CONFIRMATION: "processed" | "confirmed" | "finalized";
}

/** Built-in production defaults — used when CLIENT_ORIGIN is unset. */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://pre-richard-tion.fun",
  "https://www.pre-richard-tion.fun",
  "http://localhost:5173",
  "http://localhost:5174",
];

function require_(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(
      `[server] Missing required env var: ${key}. See .env.example for the full list.`,
    );
  }
  return v;
}

function optional(key: string): string | null {
  const v = process.env[key];
  return v && v.length > 0 ? v : null;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return DEFAULT_ALLOWED_ORIGINS;
  // Sanity-check each entry is a URL with scheme + host (no trailing slash).
  // We don't enforce a particular scheme — http://localhost is needed for dev.
  for (const p of parts) {
    try {
      const u = new URL(p);
      if (!u.protocol || !u.host) {
        throw new Error("missing scheme or host");
      }
    } catch (err) {
      throw new Error(
        `[server] CLIENT_ORIGIN entry "${p}" is not a valid URL: ${(err as Error).message}`,
      );
    }
  }
  return parts;
}

export function loadEnv(): ServerEnv {
  // SERVER_PORT (per spec) wins; fall back to PORT (legacy / Render / Railway); default 8787.
  const portStr = process.env.SERVER_PORT ?? process.env.PORT ?? "8787";
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`[server] SERVER_PORT must be an integer 1..65535, got "${portStr}"`);
  }

  const conf = (process.env.DEPOSIT_CONFIRMATION ?? "confirmed") as ServerEnv["DEPOSIT_CONFIRMATION"];
  if (!["processed", "confirmed", "finalized"].includes(conf)) {
    throw new Error(`[server] DEPOSIT_CONFIRMATION must be processed|confirmed|finalized`);
  }

  return {
    PORT: port,
    CLIENT_ORIGIN: parseOrigins(process.env.CLIENT_ORIGIN),
    ADMIN_API_KEY: require_("ADMIN_API_KEY"),
    SUPABASE_URL: require_("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: require_("SUPABASE_SERVICE_ROLE_KEY"),
    HELIUS_RPC_URL: require_("HELIUS_RPC_URL"),
    TROLL_MINT: require_("TROLL_MINT"),
    ESCROW_AUTHORITY_SECRET: require_("ESCROW_AUTHORITY_SECRET"),
    ESCROW_TOKEN_ACCOUNT_OVERRIDE: optional("ESCROW_TOKEN_ACCOUNT_OVERRIDE"),
    DEPOSIT_CONFIRMATION: conf,
  };
}
