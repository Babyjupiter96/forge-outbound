/**
 * Follow-up copy — deliberately NOT AI-generated per send. The initial
 * email carries all the personalization (it's the one email that needs
 * evidence-based specificity); these three exist to bump the thread
 * without re-pitching, so plain templates keep them cheap and
 * predictable. Every one references reaching out "last week"/etc.
 * rather than repeating the pitch, and every one is short on purpose.
 */

export interface FollowUpContext {
  contactFirstName: string | null;
  companyName: string;
  originalSubject: string;
}

export function followUpDay3(ctx: FollowUpContext): { subject: string; body: string } {
  const name = ctx.contactFirstName ?? "there";
  return {
    subject: `Re: ${ctx.originalSubject}`,
    body: `Hey ${name} — just floating this back up in case it got buried. No worries either way, just curious if it's worth a quick look.\n\nJack, Forge Digital AI`,
  };
}

export function followUpDay7(ctx: FollowUpContext): { subject: string; body: string } {
  const name = ctx.contactFirstName ?? "there";
  return {
    subject: `Re: ${ctx.originalSubject}`,
    body: `${name} — most HVAC owners we talk to are juggling calls, jobs, and everything else, so a cold email is easy to miss. If this genuinely isn't relevant right now, just say so and I'll leave it there.\n\nIf it is, happy to send a quick example of what this looks like for a business your size — no pitch, just a real example.\n\nJack, Forge Digital AI`,
  };
}

export function followUpDay14(ctx: FollowUpContext): { subject: string; body: string } {
  const name = ctx.contactFirstName ?? "there";
  return {
    subject: `Re: ${ctx.originalSubject}`,
    body: `${name} — last note from me on this. If the timing's off, no hard feelings — feel free to ignore, and I won't follow up again after this.\n\nIf you ever want to revisit it, just reply here.\n\nJack, Forge Digital AI`,
  };
}

export const SEQUENCE_STEPS = [
  { step: 1, dayOffset: 3, generate: followUpDay3 },
  { step: 2, dayOffset: 7, generate: followUpDay7 },
  { step: 3, dayOffset: 14, generate: followUpDay14 },
] as const;
