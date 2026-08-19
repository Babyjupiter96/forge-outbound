import type { Company, Contact } from "./types.js";

export interface ScoreInput {
  company: Pick<Company, "website" | "rating" | "review_count" | "service_area" | "business_description">;
  contact: Pick<Contact, "email" | "email_verification_status" | "title"> | null;
}

export interface ScoreResult {
  score: number; // 0-100
  tier: "high" | "medium" | "low";
  breakdown: Record<string, number>;
}

// Tunable constants — same philosophy as the SDR chatbot's scorer:
// plain, auditable weighted sum, not an AI judgment call. Expect to
// adjust weights after seeing real reply-rate data.
const QUALIFIED_THRESHOLD = 60; // below this: below_threshold, never auto-contacted
const HIGH_THRESHOLD = 80;

export function scoreLead({ company, contact }: ScoreInput): ScoreResult {
  const breakdown: Record<string, number> = {};

  breakdown.hasWebsite = company.website ? 20 : 0;
  breakdown.hasVerifiedContact = contact?.email && contact.email_verification_status === "valid" ? 30 : 0;
  breakdown.hasContactAtAll = !breakdown.hasVerifiedContact && contact?.email ? 10 : 0;
  breakdown.isDecisionMakerTitle = contact?.title && /owner|founder|president|ceo|general manager/i.test(contact.title) ? 15 : 5;
  breakdown.establishedPresence = (company.review_count ?? 0) >= 10 ? 15 : (company.review_count ?? 0) >= 1 ? 8 : 0;
  breakdown.decentRating = (company.rating ?? 0) >= 4.0 ? 10 : (company.rating ?? 0) >= 3.0 ? 5 : 0;
  breakdown.hasServiceAreaInfo = company.service_area ? 5 : 0;
  breakdown.hasDescription = company.business_description ? 5 : 0;

  const rawScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  const tier = score >= HIGH_THRESHOLD ? "high" : score >= QUALIFIED_THRESHOLD ? "medium" : "low";

  return { score, tier, breakdown };
}

export function isEligibleForAutoContact(result: ScoreResult): boolean {
  return result.score >= QUALIFIED_THRESHOLD;
}
