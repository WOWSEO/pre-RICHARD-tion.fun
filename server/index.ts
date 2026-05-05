import express from "express";
import cors from "cors";
import { loadEnv } from "./env";
import { marketsRouter } from "./routes/markets";
import { positionsRouter } from "./routes/positions";
import { auditRouter } from "./routes/audit";
import { adminRouter } from "./routes/admin";

function main(): void {
  const env = loadEnv();
  const app = express();

  // Production deployments behind a proxy (Render, Railway, Fly, Heroku) need
  // express to trust the X-Forwarded-* headers so req.ip and req.protocol
  // reflect the real client.  Safe to enable unconditionally — local dev
  // doesn't set these headers.
  app.set("trust proxy", true);

  app.use(express.json({ limit: "1mb" }));

  // Multi-origin CORS.  Function form lets us log every rejected origin so
  // a misspelled Netlify hostname is obvious from the logs alone — no need
  // to ship a new build to find out.  Requests without an Origin header
  // (curl, server-to-server, native apps) bypass the check; that matches
  // standard CORS semantics.
  const allowed = new Set(env.CLIENT_ORIGIN);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowed.has(origin)) return cb(null, true);
        console.warn(`[server] CORS reject origin=${origin}`);
        return cb(new Error(`origin_not_allowed: ${origin}`));
      },
      credentials: false,
    }),
  );

  // Health checks — both /api/health (existing) and /healthz (PaaS default).
  const health = (_req: express.Request, res: express.Response) => {
    res.json({ ok: true, time: new Date().toISOString() });
  };
  app.get("/api/health", health);
  app.get("/healthz", health);

  app.use("/api/markets", marketsRouter);
  app.use("/api/positions", positionsRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/admin", adminRouter);

  // Centralised error handler — keeps stack traces out of responses
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] error", err);
    if (res.headersSent) return;
    // CORS rejections from the cors() function above surface here as
    // "origin_not_allowed: ..." — return 403 (not 500) so it's clear the
    // request was rejected by policy, not crashed.
    if (err.message.startsWith("origin_not_allowed:")) {
      res.status(403).json({ error: "cors_rejected", message: err.message });
      return;
    }
    res.status(500).json({ error: "internal_error", message: err.message });
  });

  // Listen on 0.0.0.0 explicitly so Render/Railway containers can route to us.
  // Without this, Node defaults to listening on the IPv6 wildcard which
  // on some Linux containers won't accept IPv4 connections from the proxy.
  app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`[server] prerichardtion.fun API listening on 0.0.0.0:${env.PORT}`);
    console.log(`[server] CORS allow-list: ${env.CLIENT_ORIGIN.join(", ")}`);
  });
}

try {
  main();
} catch (err) {
  console.error("[server] fatal startup error", err);
  process.exit(1);
}
