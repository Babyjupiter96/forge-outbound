import { db } from "../db.js";
import { searchHvacBusinesses } from "../sources/googlePlaces.js";
import { normalizeDomain, normalizePhone, normalizeAddress } from "../dedup.js";
import { findDecisionMaker, HunterUnavailableError } from "../enrichment/hunter.js";
import { scoreLead, isEligibleForAutoContact } from "../scoring.js";
import { researchWebsite } from "../research.js";
import { generatePersonalization } from "../ai/prompt.js";
import { sendEmail } from "../email/resend.js";
import { SEQUENCE_STEPS } from "../email/templates.js";
import { checkForRepliesAndUnsubscribes } from "../email/replyCheck.js";
import type { Company, Contact } from "../types.js";

const DAILY_SEND_CAP = Number(process.env.DAILY_SEND_CAP ?? "15");
// How many (city, keyword) combos to search per day. Was 3 — far too
// conservative against Google's real 5,000 free Text Search calls/mo
// (166/day allowed). At 3/day, a small city/keyword list exhausts its
// unique businesses within ~2-3 days and every subsequent run finds
// nothing new to enrich/send (confirmed happening in production
// 2026-08-28/29 — searches ran fine, zero new companies resulted).
const NEW_SEARCHES_PER_RUN = 10;

// ---------------------------------------------------------------------------
// Phase 1: source new leads from Google Places, dedup, upsert as 'new'
// ---------------------------------------------------------------------------
async function sourceNewLeads(): Promise<number> {
  const cities = (process.env.TARGET_CITIES ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const keywords = (process.env.TARGET_KEYWORDS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (cities.length === 0 || keywords.length === 0) {
    console.warn("TARGET_CITIES or TARGET_KEYWORDS not set — skipping sourcing phase");
    return 0;
  }

  // Every (city, keyword) pair we haven't run yet, or ran longest ago —
  // this is what makes repeated daily runs expand into new ground
  // instead of re-spending API calls on the same search.
  const { data: existingSearches } = await db.from("source_searches").select("city, keyword, last_run_at");
  const seen = new Map((existingSearches ?? []).map((s) => [`${s.city}|${s.keyword}`, s.last_run_at]));

  const allPairs = cities.flatMap((city) => keywords.map((keyword) => ({ city, keyword })));
  const pairsToRun = allPairs
    .sort((a, b) => {
      const aLast = seen.get(`${a.city}|${a.keyword}`) ?? "";
      const bLast = seen.get(`${b.city}|${b.keyword}`) ?? "";
      return aLast.localeCompare(bLast); // never-run (empty string) sorts first
    })
    .slice(0, NEW_SEARCHES_PER_RUN);

  let ingested = 0;
  for (const { city, keyword } of pairsToRun) {
    const [state] = city.split(",").reverse(); // tolerate "Phoenix, AZ" or bare "Phoenix"
    const listings = await searchHvacBusinesses(city, state?.trim() || "AZ", keyword);

    for (const listing of listings) {
      const domain = normalizeDomain(listing.website);
      const phoneNormalized = normalizePhone(listing.phone);
      const addressNormalized = normalizeAddress(listing.address);

      // `domain` is the real primary dedup key (see schema notes) — the
      // same business often surfaces under a different google_place_id
      // across overlapping city/keyword searches. Conflict on domain
      // when there is one, falling back to google_place_id only for
      // domain-less listings, so this hits a clean ON CONFLICT DO
      // NOTHING instead of a raw unique-violation against the separate
      // `companies_domain_key` constraint (confirmed happening in
      // production Postgres logs before this fix).
      const { error } = await db.from("companies").upsert(
        {
          name: listing.name,
          website: listing.website,
          domain,
          phone: listing.phone,
          phone_normalized: phoneNormalized,
          address: listing.address,
          address_normalized: addressNormalized,
          city: listing.city,
          state: listing.state,
          google_place_id: listing.googlePlaceId,
          google_maps_url: listing.googleMapsUrl,
          rating: listing.rating,
          review_count: listing.reviewCount,
          business_description: listing.businessDescription,
          source: "google_places",
          status: "new",
        },
        { onConflict: domain ? "domain" : "google_place_id", ignoreDuplicates: true },
      );
      if (!error) ingested++;
    }

    await db.from("source_searches").upsert(
      { city, keyword, last_run_at: new Date().toISOString(), result_count: listings.length },
      { onConflict: "city,keyword" },
    );
  }
  return ingested;
}

// ---------------------------------------------------------------------------
// Phase 2: enrich 'new' companies with a decision-maker contact
// ---------------------------------------------------------------------------
export async function enrichNewCompanies(): Promise<{ enriched: number; deferred: number }> {
  const { data: companies } = await db.from("companies").select("*").eq("status", "new").limit(25);
  const list = (companies ?? []) as Company[];
  let enriched = 0;

  for (const [index, company] of list.entries()) {
    if (!company.domain) {
      await db.from("companies").update({ status: "no_contact_found", status_reason: "No website/domain to enrich against" }).eq("id", company.id);
      continue;
    }

    let found;
    try {
      found = await findDecisionMaker(company.domain, company.name);
    } catch (err) {
      if (err instanceof HunterUnavailableError) {
        // Not a real negative result — Hunter didn't actually answer
        // (quota exhausted, auth, 5xx, network). Leave the company as
        // 'new' so a future run retries it instead of marking it dead
        // for a reason that had nothing to do with the company itself.
        // Stop this run's enrichment loop too: if Hunter is down/out of
        // credits for one company it almost certainly is for the rest,
        // so further calls would just fail the same way and waste
        // whatever credits (or time) remain.
        console.warn(`Hunter unavailable (${err.status}) — deferring remaining enrichment to a future run: ${err.message}`);
        return { enriched, deferred: list.length - index };
      }
      throw err;
    }

    if (!found) {
      await db.from("companies").update({ status: "no_contact_found", status_reason: "No decision-maker/email found via Hunter" }).eq("id", company.id);
      continue;
    }

    await db.from("contacts").insert({
      company_id: company.id,
      first_name: found.firstName,
      last_name: found.lastName,
      title: found.title,
      email: found.email,
      email_verification_status: found.verified ? "valid" : "risky",
      linkedin_url: found.linkedinUrl,
      confidence_score: found.confidenceScore,
      enrichment_source: "hunter",
    });
    await db.from("companies").update({ status: "enriching" }).eq("id", company.id);
    enriched++;
  }
  return { enriched, deferred: 0 };
}

// ---------------------------------------------------------------------------
// Phase 3: score enriched companies, gate the below-threshold ones
// ---------------------------------------------------------------------------
async function scoreEnrichedCompanies(): Promise<void> {
  const { data: companies } = await db.from("companies").select("*").eq("status", "enriching").limit(25);
  for (const company of (companies ?? []) as Company[]) {
    const { data: contact } = await db.from("contacts").select("*").eq("company_id", company.id).maybeSingle();
    const result = scoreLead({ company, contact: contact as Contact | null });

    await db
      .from("companies")
      .update({
        lead_score: result.score,
        lead_tier: result.tier,
        status: isEligibleForAutoContact(result) ? "ready" : "below_threshold",
        status_reason: isEligibleForAutoContact(result) ? null : `Score ${result.score} below the 60-point auto-contact threshold`,
      })
      .eq("id", company.id);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: research + generate the initial personalized email for 'ready'
// companies, respecting the daily send cap
// ---------------------------------------------------------------------------
async function researchAndSendInitial(remainingSendBudget: number): Promise<number> {
  if (remainingSendBudget <= 0) return 0;

  const { data: companies } = await db.from("companies").select("*").eq("status", "ready").limit(remainingSendBudget);
  let sent = 0;

  for (const company of (companies ?? []) as Company[]) {
    const { data: contact } = await db.from("contacts").select("*").eq("company_id", company.id).maybeSingle();
    if (!contact?.email) continue;

    const suppressed = await db.from("suppressions").select("email").eq("email", contact.email).maybeSingle();
    if (suppressed.data) {
      await db.from("companies").update({ status: "suppressed", status_reason: "Email on the suppression list" }).eq("id", company.id);
      continue;
    }

    const observations = await researchWebsite(company.website);
    const personalization = await generatePersonalization({
      companyName: company.name,
      city: company.city ?? "",
      state: company.state ?? "",
      website: company.website,
      rating: company.rating,
      reviewCount: company.review_count,
      observations,
      contactFirstName: contact.first_name,
      contactTitle: contact.title,
    });

    await db.from("research").insert({
      company_id: company.id,
      website_observations: observations,
      pain_point: personalization.personalization_angle,
      recommended_service: personalization.primary_opportunity,
      evidence: personalization.evidence,
    });

    const { resendEmailId } = await sendEmail({
      to: contact.email,
      subject: personalization.email_subject,
      body: personalization.email_body,
    });

    await db.from("outreach").insert({
      company_id: company.id,
      contact_id: contact.id,
      sequence_step: 0,
      subject: personalization.email_subject,
      body: personalization.email_body,
      resend_email_id: resendEmailId,
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    await db.from("companies").update({ status: "active" }).eq("id", company.id);
    sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Phase 5: send due follow-ups for 'active' companies
// ---------------------------------------------------------------------------
async function sendDueFollowUps(remainingSendBudget: number): Promise<number> {
  if (remainingSendBudget <= 0) return 0;

  const { data: activeCompanies } = await db.from("companies").select("*").eq("status", "active");
  let sent = 0;

  for (const company of (activeCompanies ?? []) as Company[]) {
    if (sent >= remainingSendBudget) break;

    const { data: history } = await db
      .from("outreach")
      .select("*")
      .eq("company_id", company.id)
      .order("sequence_step", { ascending: false })
      .limit(1);
    const lastOutreach = history?.[0];
    if (!lastOutreach || lastOutreach.status === "replied" || lastOutreach.status === "bounced") continue;

    const nextStep = SEQUENCE_STEPS.find((s) => s.step === lastOutreach.sequence_step + 1);
    if (!nextStep) {
      await db.from("companies").update({ status: "sequence_complete" }).eq("id", company.id);
      continue;
    }

    const daysSinceLast = (Date.now() - new Date(lastOutreach.sent_at).getTime()) / 86_400_000;
    if (daysSinceLast < nextStep.dayOffset) continue; // not due yet

    const { data: contact } = await db.from("contacts").select("*").eq("id", lastOutreach.contact_id).maybeSingle();
    if (!contact?.email) continue;

    const suppressed = await db.from("suppressions").select("email").eq("email", contact.email).maybeSingle();
    if (suppressed.data) {
      await db.from("companies").update({ status: "suppressed" }).eq("id", company.id);
      continue;
    }

    const { subject, body } = nextStep.generate({
      contactFirstName: contact.first_name,
      companyName: company.name,
      originalSubject: lastOutreach.subject,
    });

    const { resendEmailId } = await sendEmail({ to: contact.email, subject, body });

    await db.from("outreach").insert({
      company_id: company.id,
      contact_id: contact.id,
      sequence_step: nextStep.step,
      subject,
      body,
      resend_email_id: resendEmailId,
      status: "sent",
      sent_at: new Date().toISOString(),
    });
    sent++;
  }
  return sent;
}

export interface PipelineRunSummary {
  leadsIngested: number;
  leadsEnriched: number;
  leadsDeferred: number;
  initialEmailsSent: number;
  followUpsSent: number;
  repliesDetected: number;
  unsubscribesDetected: number;
}

/**
 * The single entry point the daily cron calls. Order matters: replies
 * and unsubscribes are checked LAST so anything that came in overnight
 * is reflected before the next run, not this one — but sourcing/
 * enrichment/scoring run first so a fresh lead can theoretically reach
 * 'ready' status within the same run its lead source was discovered.
 */
export async function runPipeline(): Promise<PipelineRunSummary> {
  const leadsIngested = await sourceNewLeads();
  const { enriched: leadsEnriched, deferred: leadsDeferred } = await enrichNewCompanies();
  await scoreEnrichedCompanies();

  const initialEmailsSent = await researchAndSendInitial(DAILY_SEND_CAP);
  const followUpsSent = await sendDueFollowUps(DAILY_SEND_CAP - initialEmailsSent);

  const { repliesFound, unsubscribesFound } = await checkForRepliesAndUnsubscribes();

  return {
    leadsIngested,
    leadsEnriched,
    leadsDeferred,
    initialEmailsSent,
    followUpsSent,
    repliesDetected: repliesFound,
    unsubscribesDetected: unsubscribesFound,
  };
}

// Allows `pnpm run-pipeline` to run this locally for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline()
    .then((summary) => {
      console.log("Pipeline run complete:", summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Pipeline run failed:", err);
      process.exit(1);
    });
}
