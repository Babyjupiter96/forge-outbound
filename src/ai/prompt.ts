import OpenAI from "openai";
import { z } from "zod";
import { FORGE_SERVICES, type WebsiteObservations } from "../types.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const PersonalizationSchema = z.object({
  has_sufficient_evidence: z
    .boolean()
    .describe("false if the observations are too thin to say anything specific and honest — triggers manual review instead of a generic email"),
  primary_opportunity: z.enum(FORGE_SERVICES),
  evidence: z
    .string()
    .describe("The specific observation from the input that justifies primary_opportunity. Must be traceable to a field in websiteObservations — never invented."),
  personalization_angle: z.string().describe("One sentence: the specific, true thing about THIS business the email opens with."),
  email_subject: z.string().max(80),
  email_body: z.string(),
});

export type Personalization = z.infer<typeof PersonalizationSchema>;

export interface PersonalizationInput {
  companyName: string;
  city: string;
  state: string;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  observations: WebsiteObservations;
  contactFirstName: string | null;
  contactTitle: string | null;
}

/**
 * The actual production system prompt. Every constraint here maps
 * directly to a rule from the spec's Compliance section — this isn't
 * generic "be helpful" boilerplate, each line is load-bearing.
 */
const SYSTEM_PROMPT = `You are writing a single cold outreach email from Jack at Forge Digital AI to an HVAC business owner/decision-maker.

Forge Digital AI builds: AI chat widgets, missed-call automation, lead follow-up automation, website redesigns, conversion optimization, appointment booking automation, AI customer service, CRM automation, and marketing automation for local service businesses.

## What you are given
Real, evidence-based observations about ONE specific HVAC business — their website (if any), a handful of booleans about what it does/doesn't have, their Google rating and review count, and who you're writing to.

## Hard rules — violating any of these makes the output unusable
1. Pick exactly ONE Forge service to pitch (primary_opportunity) — never mention or imply multiple services in the email body.
2. "evidence" must be a direct restatement of something literally present in the input data (e.g. "no online booking detected", "no chat widget detected", "23 Google reviews at a 3.2 rating"). If you cannot point to a specific input field justifying a claim, do not make the claim.
3. Never say you "noticed," "saw," "checked out," or otherwise claim to have visited/used their business, service, or booked with them. You are working from data, not experience — write from that honest position (e.g. "most HVAC sites we come across don't have X" is fine; "I called your office and..." is not, unless that specific event is literally in the input).
4. Never invent a specific number, statistic, or claim about THIS business that isn't in the input (no "you're losing $X/month," no "73% of your leads," etc.) — those are exactly the fabricated-pain-point claims this system exists to avoid.
5. If has_website is false, or the observations are too thin to say anything specific and honest, set has_sufficient_evidence to false and still fill in a generic-but-honest fallback angle (e.g. "no website on file — worth having something simple that converts") rather than inventing detail.
6. No generic AI-speak, no corporate jargon ("synergy," "leverage," "streamline," "unlock"), no long paragraphs, no exaggerated claims, no spammy urgency language ("act now," "limited time"). Write like a real person who does this work, in 4-6 short sentences.
7. End with a low-pressure ask — a question, not a hard CTA button/link (there is no link to give here; a reply is the only next step).
8. Sign off as "Jack, Forge Digital AI" — nothing else.`;

export async function generatePersonalization(input: PersonalizationInput): Promise<Personalization> {
  const userPrompt = `Company: ${input.companyName}
Location: ${input.city}, ${input.state}
Website: ${input.website ?? "none on file"}
Google rating: ${input.rating ?? "unknown"} (${input.reviewCount ?? 0} reviews)
Recipient: ${input.contactFirstName ?? "there"}${input.contactTitle ? `, ${input.contactTitle}` : ""}

Website observations (only source of truth for claims about this business):
${JSON.stringify(input.observations, null, 2)}`;

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "personalization",
        strict: true,
        schema: {
          type: "object",
          properties: {
            has_sufficient_evidence: { type: "boolean" },
            primary_opportunity: { type: "string", enum: FORGE_SERVICES as unknown as string[] },
            evidence: { type: "string" },
            personalization_angle: { type: "string" },
            email_subject: { type: "string" },
            email_body: { type: "string" },
          },
          required: [
            "has_sufficient_evidence",
            "primary_opportunity",
            "evidence",
            "personalization_angle",
            "email_subject",
            "email_body",
          ],
          additionalProperties: false,
        },
      },
    },
  });

  const raw = completion.choices[0]?.message.content;
  if (!raw) throw new Error("OpenAI returned no content for personalization");

  return PersonalizationSchema.parse(JSON.parse(raw));
}
