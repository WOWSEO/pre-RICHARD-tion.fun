import "dotenv/config";

/**
 * All env vars consumed by the server. We fail fast at boot if a required
 * variable is missing, rather than at the first DB call. The server intentionally
 * uses a different env vocabulary than the Vite client (`VITE_*`).
 *
 * AUDIT NOTE: the spec lists the port variable as `SERVER_PORT`. We accept either
 * `SERVER_PORT` (preferred) or `PORT` (legacy), in that order, so existing .env
 * files keep working.
 */
export interface ServerEnv {
  PORT: number;
  CLIENT_ORIGIN: string;
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

export function loadEnv(): ServerEnv {
  // SERVER_PORT (per spec) wins; fall back to PORT (legacy); default 8787.
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
    CLIENT_ORIGIN: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
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
