import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "../db.js";

/**
 * Resend (and most transactional-email APIs) sends, but doesn't receive
 * — there's no webhook for "the prospect replied." So OUTBOUND_REPLY_TO
 * needs to be a real inbox (see README: ImprovMX forwards it to the
 * user's own Gmail), and this function polls it once per daily cron
 * run via IMAP.
 *
 * Deliberately blunt on purpose: ANY reply from an address we've
 * emailed stops that sequence, full stop — no sentiment analysis, no
 * "is this actually interested" judgment call. The spec's rule is
 * "never continue after a reply," not "never continue after a
 * negative reply."
 *
 * Tracked by IMAP UID high-water-mark (`imap_checkpoint` table), NOT
 * the \Seen flag. This inbox is the user's own actively-used personal
 * Gmail — if they read a reply themselves in the normal course of
 * checking email, a seen:false-based check would silently never see
 * it again. Confirmed happening in production: a real prospect reply
 * went undetected because the user had already opened it. UIDs only
 * increase and are unaffected by the user reading mail, so this is
 * immune to that race.
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

  const { data: checkpoint } = await db.from("imap_checkpoint").select("last_uid").eq("id", true).single();
  const lastUid = checkpoint?.last_uid ?? 0;
  let highestUidSeen = lastUid;

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidNext = client.mailbox && "uidNext" in client.mailbox ? client.mailbox.uidNext : undefined;
      // Nothing new since last checkpoint — skip the fetch entirely.
      if (uidNext !== undefined && uidNext - 1 <= lastUid) {
        return { repliesFound, unsubscribesFound };
      }

      for await (const message of client.fetch(
        { uid: `${lastUid + 1}:*` },
        { envelope: true, source: true, uid: true },
      )) {
        if (message.uid > highestUidSeen) highestUidSeen = message.uid;
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

  if (highestUidSeen > lastUid) {
    await db.from("imap_checkpoint").update({ last_uid: highestUidSeen, updated_at: new Date().toISOString() }).eq("id", true);
  }

  return { repliesFound, unsubscribesFound };
}
