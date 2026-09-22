/**
 * Hunter.io enrichment — finds the decision-maker at a company and a
 * business email, via Domain Search.
 *
 * Swapped in to replace Apollo: Apollo's free plan turned out to block
 * API access entirely ("not accessible, even with a master key" —
 * confirmed directly against a live key, not a docs assumption). Hunter's
 * free plan (50 credits/month, 1 credit = 1 email found) does include
 * real API access, so it's the actual $0 option here. See README for
 * the volume tradeoff this implies.
 */

const API_KEY = process.env.HUNTER_API_KEY;
const BASE_URL = "https://api.hunter.io/v2";

// In priority order — the first title match wins. Matched by substring
// against Hunter's returned position, case-insensitive.
const TITLE_PRIORITY = [
  "owner",
  "founder",
  "president",
  "ceo",
  "chief executive",
  "general manager",
  "marketing director",
  "operations manager",
];

interface HunterEmail {
  value: string;
  type: string | null; // 'personal' | 'generic'
  confidence: number | null;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  linkedin: string | null;
  verification: { status: string | null } | null;
}

interface DecisionMakerResult {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  confidenceScore: number;
  verified: boolean;
}

/**
 * A Hunter call that failed before it could actually check the domain —
 * quota exhaustion (429), an auth problem, a 5xx, a network error. This
 * is NOT the same fact as "we checked and there's no email," and callers
 * must not treat it as one: a company hit during an outage should stay
 * eligible for enrichment on a future run, not get permanently marked
 * no_contact_found for a reason that had nothing to do with the company.
 */
export class HunterUnavailableError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HunterUnavailableError";
  }
}

function rankByTitlePriority(emails: HunterEmail[]): HunterEmail[] {
  return [...emails].sort((a, b) => {
    const aRank = TITLE_PRIORITY.findIndex((t) => a.position?.toLowerCase().includes(t));
    const bRank = TITLE_PRIORITY.findIndex((t) => b.position?.toLowerCase().includes(t));
    const aScore = aRank === -1 ? TITLE_PRIORITY.length : aRank;
    const bScore = bRank === -1 ? TITLE_PRIORITY.length : bRank;
    return aScore - bScore;
  });
}

/**
 * Finds the best decision-maker for a company by domain. Returns null
 * only for a genuine negative result (Hunter answered, no usable
 * personal email) — never a guessed/fabricated contact. A failed call
 * (quota, auth, network, 5xx) throws HunterUnavailableError instead of
 * returning null, so it can't be silently mistaken for "no email found."
 */
export async function findDecisionMaker(domain: string, companyName: string): Promise<DecisionMakerResult | null> {
  if (!API_KEY) throw new Error("HUNTER_API_KEY not set");

  const url = `${BASE_URL}/domain-search?domain=${encodeURIComponent(domain)}&api_key=${API_KEY}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new HunterUnavailableError(0, `Hunter domain search network error for ${companyName} (${domain}): ${err}`);
  }

  if (!res.ok) {
    throw new HunterUnavailableError(
      res.status,
      `Hunter domain search failed for ${companyName} (${domain}): ${res.status}`,
    );
  }

  const data = (await res.json()) as { data?: { emails?: HunterEmail[] } };
  // Named, personal emails only — never fall back to a generic
  // info@/support@ inbox as a stand-in for a decision-maker.
  const personalEmails = (data.data?.emails ?? []).filter((e) => e.type === "personal" && e.value);
  const ranked = rankByTitlePriority(personalEmails);
  const best = ranked[0];
  if (!best?.value) return null;

  const confidence = best.confidence ?? 0;
  const verified = best.verification?.status === "valid" && confidence >= 80;

  return {
    firstName: best.first_name,
    lastName: best.last_name,
    title: best.position,
    email: best.value,
    linkedinUrl: best.linkedin,
    confidenceScore: confidence / 100,
    verified,
  };
}
