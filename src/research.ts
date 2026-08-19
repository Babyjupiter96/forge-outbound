import type { WebsiteObservations } from "./types.js";

/**
 * Deliberately dumb and evidence-based: plain fetch + string/regex
 * checks against the actual HTML, not an AI guessing what the site
 * probably has. Every field here is something a human could verify by
 * viewing source. This is what makes the "never fabricate a pain
 * point" rule enforceable downstream — the AI prompt only ever sees
 * these concrete booleans plus a short raw-text excerpt, never asked
 * to invent what it can't see.
 *
 * Known MVP limitation: this doesn't execute JavaScript, so a chat
 * widget or booking tool that only renders client-side after page load
 * won't be detected — it'll show up as `false` when the truth is
 * "present but undetectable this way." That's a false negative, not a
 * fabrication, so it's the safe direction to be wrong in for this
 * specific pipeline. Worth a headless-browser upgrade later if it
 * turns out to matter.
 */
export async function researchWebsite(website: string | null): Promise<WebsiteObservations> {
  if (!website) {
    return {
      has_website: false,
      has_chat_widget: false,
      has_online_booking: false,
      has_lead_form: false,
      has_clear_cta: false,
      looks_dated: false,
      raw_notes: "No website on file.",
    };
  }

  let html: string;
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ForgeOutboundResearchBot/1.0)" },
    });
    html = await res.text();
  } catch (err) {
    return {
      has_website: true,
      has_chat_widget: false,
      has_online_booking: false,
      has_lead_form: false,
      has_clear_cta: false,
      looks_dated: false,
      raw_notes: `Website listed but unreachable (${err instanceof Error ? err.message : "unknown error"}).`,
    };
  }

  const lower = html.toLowerCase();

  const CHAT_SIGNALS = ["intercom", "drift.com", "tawk.to", "livechat", "chatwidget", "crisp.chat", "tidio"];
  const BOOKING_SIGNALS = ["calendly", "acuityscheduling", "housecallpro", "servicetitan", "book-now", "schedule-now", "bookonline"];
  const FORM_SIGNALS = ["<form", "contact-form", "gravityform", "hubspot-form", "wpforms"];
  const CTA_SIGNALS = ["call now", "get a quote", "free estimate", "schedule service", "request service", "book now"];
  const DATED_SIGNALS = ["<marquee", "<font ", "flash object", "under construction", "best viewed in"];

  const hasAny = (signals: string[]) => signals.some((s) => lower.includes(s));

  const titleMatch = html.match(/<title>([^<]{0,200})<\/title>/i);
  const excerpt = titleMatch?.[1] ? titleMatch[1].trim().slice(0, 150) : "(no <title> tag found)";

  return {
    has_website: true,
    has_chat_widget: hasAny(CHAT_SIGNALS),
    has_online_booking: hasAny(BOOKING_SIGNALS),
    has_lead_form: hasAny(FORM_SIGNALS),
    has_clear_cta: hasAny(CTA_SIGNALS),
    looks_dated: hasAny(DATED_SIGNALS),
    raw_notes: `Page title: "${excerpt}"`,
  };
}
