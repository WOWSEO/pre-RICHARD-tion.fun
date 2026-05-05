import { Router } from "express";
import { db, type AuditReceiptRow } from "../db/supabase";

export const auditRouter = Router();

auditRouter.get("/:marketId", async (req, res, next) => {
  try {
    const sb = db();
    const { data, error } = await sb
      .from("audit_receipts")
      .select("*")
      .eq("market_id", req.params.marketId!)
      .maybeSingle<AuditReceiptRow>();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "audit_not_found" });
    res.json({ receipt: data });
  } catch (err) {
    next(err);
  }
});
