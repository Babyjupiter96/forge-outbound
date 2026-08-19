import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runPipeline } from "../../src/pipeline/runPipeline.js";

/**
 * Vercel signs cron requests with an Authorization header matching
 * CRON_SECRET automatically when triggered by the scheduler — this
 * check just makes sure a stray request to this URL (anyone who finds
 * it) can't trigger real sends.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const summary = await runPipeline();
    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error("Pipeline run failed:", err);
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "unknown error" });
  }
}
