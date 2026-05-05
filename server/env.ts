import "dotenv/config";

/**
 * All env vars consumed by the server.  Fail-fast at boot if a required
 * variable is missing, rather than at the first DB call.
 *
 * Two-port convention:
 *   - SERVER_PORT (preferred per spec) or PORT (legacy, what Render/Railway
 *     inject) — both accepted, SERVER_PORT wins if both are set.
 *
 * CORS allow-list resolution (in order):
 *   1. CORS_ORIGINS (new spec name) — comma-separated list.  If set and
 *      non-empty, this is canonical.  Wins over everything below.
 *   2. CLIENT_ORIGIN (legacy alias from v9) — same format, kept so that
 *      operators with an existing CLIENT_ORIGIN setting on Render don't
 *      have to migrate atomically.  If CORS_ORIGINS is unset and
 *      CLIENT_ORIGIN is set, CLIENT_ORIGIN is used.
 *   3. Built-in defaults — used when both env vars are unset:
 *        - NODE_ENV=production → all 4 spec'd origins
 *          (https://pre-richard-tion.fun, https://www.pre-richard-tion.fun,
 *           http://localhost:5173, http://localhost:5174).
 *          The prod hostnames are baked in so a brand-new deploy where the
 *          operator forgets to set CORS_ORIGINS still serves the live site.
 *        - otherwise (dev) → localhost:5173 + localhost:5174 only.
 *
 * The resolved list is logged at startup along with its source so a misconfig
 * is obvious from the first server log line.
 */
export interface ServerEnv {
  PORT: number;
  /**
   * Allow-list of browser origins for CORS.  An incoming request with an
   * Origin header NOT in this list is rejected at the CORS layer.  Requests
   * without an Origin header (curl, server-to-server, native apps) bypass the
   * check — that's standard CORS semantics.
   */
  CORS_ORIGINS: string[];
  /**
   * Where the CORS_ORIGINS value came from.  Logged at startup so a misconfig
   * is obvious from the first server log line.
   */
  CORS_ORIGINS_SOURCE: "CORS_ORIGINS" | "CLIENT_ORIGIN_legacy" | "default_production" | "default_development";
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

/**
 * Built-in defaults.
 *
 *   PROD: all four spec'd origins, so a fresh deploy with no env vars at all
 *         still serves the live Netlify site (req #4).  Localhost stays in
 *         the list so a developer can run a local Vite frontend against the
 *         prod API for debugging without env wiring.
 *
 *   DEV:  localhost only.  A misspelled hostname during local dev will
 *         surface as a CORS reject in the log instead of being silently
 *         allowed by a permissive prod-default list.
 */
const DEFAULTS_PRODUCTION = [
  "https://pre-richard-tion.fun",
  "https://www.pre-richard-tion.fun",
  "http://localhost:5173",
  "http://localhost:5174",
];
const DEFAULTS_DEVELOPMENT = [
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

/**
 * Pure parser: comma-separated → array of validated origins.  Returns null
 * if the input is empty/whitespace; the caller then falls through to the
 * next priority level.  Throws if any entry is malformed — we'd rather
 * crash at boot than 500 on every browser request.
 */
function parseOrigins(raw: string | undefined, sourceName: string): string[] | null {
  if (!raw || raw.trim().length === 0) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  // Sanity-check: each entry is a URL with scheme + host (no trailing slash).
  // We don't enforce a particular scheme — http://localhost is needed for dev.
  for (const p of parts) {
    try {
      const u = new URL(p);
      if (!u.protocol || !u.host) {
        throw new Error("missing scheme or host");
      }
    } catch (err) {
      throw new Error(
        `[server] ${sourceName} entry "${p}" is not a valid URL: ${(err as Error).message}`,
      );
    }
  }
  return parts;
}

/**
 * Walks the resolution chain documented at the top of this file.  Returns
 * both the resolved list AND a tag identifying which priority level
 * provided it — so the startup log line is unambiguous about why those
 * specific origins are allowed.
 */
function resolveCorsOrigins(): { origins: string[]; source: ServerEnv["CORS_ORIGINS_SOURCE"] } {
  // Priority 1: CORS_ORIGINS (new spec name).
  const fromCors = parseOrigins(process.env.CORS_ORIGINS, "CORS_ORIGINS");
  if (fromCors) return { origins: fromCors, source: "CORS_ORIGINS" };

  // Priority 2: CLIENT_ORIGIN (legacy alias from v9).  Kept so an existing
  // Render setup doesn't break — but if CLIENT_ORIGIN got mis-set to just
  // "http://localhost:5173" (the symptom that motivated this patch), the
  // operator can switch to CORS_ORIGINS in their Render dashboard and the
  // new value wins, no code change required.
  const fromLegacy = parseOrigins(process.env.CLIENT_ORIGIN, "CLIENT_ORIGIN");
  if (fromLegacy) return { origins: fromLegacy, source: "CLIENT_ORIGIN_legacy" };

  // Priority 3: hard-coded defaults, branched on NODE_ENV.
  if (process.env.NODE_ENV === "production") {
    return { origins: DEFAULTS_PRODUCTION, source: "default_production" };
  }
  return { origins: DEFAULTS_DEVELOPMENT, source: "default_development" };
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

  const cors = resolveCorsOrigins();

  return {
    PORT: port,
    CORS_ORIGINS: cors.origins,
    CORS_ORIGINS_SOURCE: cors.source,
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
