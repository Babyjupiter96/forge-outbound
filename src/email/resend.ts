import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.OUTBOUND_FROM_EMAIL!;
const FROM_NAME = process.env.OUTBOUND_FROM_NAME ?? "Forge Digital AI";
const REPLY_TO = process.env.OUTBOUND_REPLY_TO ?? FROM_EMAIL;

export interface SendResult {
  resendEmailId: string;
}

/**
 * Every send includes a real List-Unsubscribe header — CAN-SPAM
 * doesn't strictly require the one-click header for B2B cold email,
 * but it's cheap to include and unambiguously the right thing to do.
 * The mailto link routes to the same inbox the reply-checker polls,
 * so an unsubscribe request lands in the same place a reply would.
 */
export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
}): Promise<SendResult> {
  const { data, error } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: params.to,
    replyTo: REPLY_TO,
    subject: params.subject,
    text: params.body,
    headers: {
      "List-Unsubscribe": `<mailto:${REPLY_TO}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });

  if (error || !data) {
    throw new Error(`Resend send failed: ${error?.message ?? "unknown error"}`);
  }
  return { resendEmailId: data.id };
}
