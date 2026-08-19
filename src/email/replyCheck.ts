import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "../db.js";

/**
 * Resend (and most transactional-email APIs) sends, but doesn't receive
 * — there's no webhook for "the prospect replied." So OUTBOUND_REPLY_TO
 * needs to be a real inbox (see README: Zoho Mail free tier is the
 * recommended provider for this), and this function polls it once per
 * daily cron run via IMAP.
 *
 * Deliberately blunt on purpose: ANY reply from an address we've
 * emailed stops that sequence, full stop — no sentiment analysis, no
 * "is this actually interested" judgment call. The spec's rule is
 * "never continue after a reply," not "never continue after a
 * negative reply."
 */
export async function checkForRepliesAndUnsubscribes(): Promise<{ repliesFound: number; unsubscribesFound: number }> {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST!,
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
    logger: false,
  });

  let repliesFound = 0;
  let unsubscribesFound = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Only unseen messages — each message is marked seen as it's
      // processed, so a message is never double-counted across runs.
      for await (const message of client.fetch({ seen: false }, { envelope: true, source: true })) {
        if (!message.source) continue;
        const parsed: ParsedMail = await simpleParser(message.source, {});
        const fromAddress = parsed.from?.value[0]?.address?.toLowerCase();
        if (!fromAddress) continue;

        const isUnsubscribeRequest = /unsubscribe/i.test(parsed.subject ?? "");

        if (isUnsubscribeRequest) {
          await db.from("suppressions").upsert(
            { email: fromAddress, reason: "unsubscribed" },
            { onConflict: "email" },
          );
          await db.from("companies").update({ status: "unsubscribed" }).eq(
            "id",
            (
              await db
                .from("contacts")
                .select("company_id")
                .eq("email", fromAddress)
                .maybeSingle()
            ).data?.company_id ?? "",
          );
          unsubscribesFound++;
          continue;
        }

        const contact = await db.from("contacts").select("id, company_id").eq("email", fromAddress).maybeSingle();
        if (contact.data) {
          await db.from("outreach").update({ status: "replied", replied_at: new Date().toISOString() }).eq(
            "contact_id",
            contact.data.id,
          );
          await db.from("companies").update({ status: "replied" }).eq("id", contact.data.company_id);
          repliesFound++;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { repliesFound, unsubscribesFound };
}
