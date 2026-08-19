/**
 * Apollo.io enrichment — finds the decision-maker at a company and
 * reveals a verified business email.
 *
 * NOTE: Apollo's API surface shifts fairly often between free-tier
 * accounts. The endpoints/fields below are correct as documented, but
 * the FIRST real run against a live key should be treated as a
 * verification step, not an assumption — see README "Testing plan",
 * step 2. Don't skip that step just because this compiles.
 */

const API_KEY = process.env.APOLLO_API_KEY;
const BASE_URL = "https://api.apollo.io/v1";

// In priority order — the first title match wins. Matched by substring
// against Apollo's returned title, case-insensitive.
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

interface ApolloPerson {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_status: string | null; // 'verified' | 'guessed' | 'unavailable' | ...
  id: string;
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

function rankByTitlePriority(people: ApolloPerson[]): ApolloPerson[] {
  return [...people].sort((a, b) => {
    const aRank = TITLE_PRIORITY.findIndex((t) => a.title?.toLowerCase().includes(t));
    const bRank = TITLE_PRIORITY.findIndex((t) => b.title?.toLowerCase().includes(t));
    const aScore = aRank === -1 ? TITLE_PRIORITY.length : aRank;
    const bScore = bRank === -1 ? TITLE_PRIORITY.length : bRank;
    return aScore - bScore;
  });
}

/**
 * Finds the best decision-maker for a company by domain. Returns null
 * rather than a guessed/fabricated contact if nothing usable is found —
 * callers must treat null as "no_contact_found", never fill in a guess.
 */
export async function findDecisionMaker(domain: string, companyName: string): Promise<DecisionMakerResult | null> {
  if (!API_KEY) throw new Error("APOLLO_API_KEY not set");

  const searchRes = await fetch(`${BASE_URL}/mixed_people/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": API_KEY },
    body: JSON.stringify({
      q_organization_domains: domain,
      person_titles: TITLE_PRIORITY,
      page: 1,
      per_page: 10,
    }),
  });

  if (!searchRes.ok) {
    console.error(`Apollo search failed for ${companyName} (${domain}): ${searchRes.status}`);
    return null;
  }

  const searchData = (await searchRes.json()) as { people?: ApolloPerson[] };
  const ranked = rankByTitlePriority(searchData.people ?? []);
  const best = ranked[0];
  if (!best) return null;

  // The search endpoint typically doesn't reveal the actual email —
  // `match` is the credit-consuming call that does. Only spend it on
  // the one candidate we've already decided is the best fit.
  const matchRes = await fetch(`${BASE_URL}/people/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": API_KEY },
    body: JSON.stringify({
      first_name: best.first_name,
      last_name: best.last_name,
      organization_name: companyName,
      domain,
      reveal_personal_emails: false,
    }),
  });

  if (!matchRes.ok) {
    console.error(`Apollo match failed for ${companyName}: ${matchRes.status}`);
    return null;
  }

  const matchData = (await matchRes.json()) as { person?: ApolloPerson };
  const matched = matchData.person ?? best;

  if (!matched.email) return null;

  const verified = matched.email_status === "verified";
  return {
    firstName: matched.first_name,
    lastName: matched.last_name,
    title: matched.title,
    email: matched.email,
    linkedinUrl: matched.linkedin_url,
    confidenceScore: verified ? 0.9 : 0.5,
    verified,
  };
}
