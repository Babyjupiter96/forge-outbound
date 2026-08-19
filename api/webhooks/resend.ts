import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Webhook } from "svix";
import { db } from "../../src/db.js";

// Resend signs webhooks via Svix — this verifies the signature so a
// forged request can't mark real prospects as bounced/complained
// (which would silently suppress legitimate leads).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "RESEND_WEBHOOK_SECRET not configured" });

  const payload = JSON.stringify(req.body);
  const headers = {
    "svix-id": req.headers["svix-id"] as string,
    "svix-timestamp": req.headers["svix-timestamp"] as string,
    "svix-signature": req.headers["svix-signature"] as string,
  };

  let event: { type: string; data: { email_id: string } };
  try {
    event = new Webhook(secret).verify(payload, headers) as typeof event;
  } catch {
    return res.status(401).json({ error: "invalid signature" });
  }

  const emailId = event.data.email_id;
  const { data: outreachRow } = await db.from("outreach").select("id, company_id").eq("resend_email_id", emailId).maybeSingle();
  if (!outreachRow) return res.status(200).json({ ok: true, note: "no matching outreach row" });

  switch (event.type) {
    case "email.delivered":
      await db.from("outreach").update({ status: "delivered", delivered_at: new Date().toISOString() }).eq("id", outreachRow.id);
      break;
    case "email.bounced":
      await db.from("outreach").update({ status: "bounced", bounced_at: new Date().toISOString() }).eq("id", outreachRow.id);
      await db.from("companies").update({ status: "bounced" }).eq("id", outreachRow.company_id);
      // A hard bounce means the address is dead — suppress it so no
      // future campaign (or a re-discovered duplicate) tries it again.
      {
        const { data: contact } = await db.from("outreach").select("contact_id").eq("id", outreachRow.id).maybeSingle();
        if (contact) {
          const { data: c } = await db.from("contacts").select("email").eq("id", contact.contact_id).maybeSingle();
          if (c?.email) await db.from("suppressions").upsert({ email: c.email, reason: "bounced" }, { onConflict: "email" });
        }
      }
      break;
    case "email.complained":
      await db.from("outreach").update({ status: "complained" }).eq("id", outreachRow.id);
      await db.from("companies").update({ status: "suppressed" }).eq("id", outreachRow.company_id);
      break;
    case "email.opened":
      await db.from("outreach").update({ status: "opened" }).eq("id", outreachRow.id);
      break;
  }

  return res.status(200).json({ ok: true });
}
