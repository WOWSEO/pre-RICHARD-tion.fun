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

  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: false,
    }),
  );

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api/markets", marketsRouter);
  app.use("/api/positions", positionsRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/admin", adminRouter);

  // Centralised error handler — keeps stack traces out of responses
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] error", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message: err.message });
  });

  app.listen(env.PORT, () => {
    console.log(`[server] prerichardtion.fun API listening on :${env.PORT}`);
    console.log(`[server] CORS origin: ${env.CLIENT_ORIGIN}`);
  });
}

try {
  main();
} catch (err) {
  console.error("[server] fatal startup error", err);
  process.exit(1);
}
