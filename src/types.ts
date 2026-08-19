export interface Company {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
  phone: string | null;
  phone_normalized: string | null;
  address: string | null;
  address_normalized: string | null;
  city: string | null;
  state: string | null;
  industry: string;
  google_place_id: string | null;
  google_maps_url: string | null;
  rating: number | null;
  review_count: number | null;
  service_area: string | null;
  business_description: string | null;
  source: string;
  lead_score: number | null;
  lead_tier: "high" | "medium" | "low" | null;
  status: CompanyStatus;
  status_reason: string | null;
}

export type CompanyStatus =
  | "new"
  | "enriching"
  | "no_contact_found"
  | "ready"
  | "below_threshold"
  | "queued"
  | "active"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "not_interested"
  | "sequence_complete"
  | "suppressed";

export interface Contact {
  id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_verification_status: "unverified" | "valid" | "risky" | "invalid";
  linkedin_url: string | null;
  confidence_score: number | null;
  enrichment_source: string | null;
}

export interface Research {
  id: string;
  company_id: string;
  website_observations: WebsiteObservations;
  pain_point: string;
  recommended_service: ForgeService;
  evidence: string;
}

export interface WebsiteObservations {
  has_website: boolean;
  has_chat_widget: boolean;
  has_online_booking: boolean;
  has_lead_form: boolean;
  has_clear_cta: boolean;
  looks_dated: boolean;
  raw_notes: string;
}

export const FORGE_SERVICES = [
  "ai_chat_widget",
  "missed_call_automation",
  "lead_followup_automation",
  "website_redesign",
  "conversion_optimization",
  "appointment_booking_automation",
  "ai_customer_service",
  "crm_automation",
  "marketing_automation",
] as const;

export type ForgeService = (typeof FORGE_SERVICES)[number];

export interface RawBusinessListing {
  name: string;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string;
  state: string;
  googlePlaceId: string;
  googleMapsUrl: string;
  rating: number | null;
  reviewCount: number | null;
  businessDescription: string | null;
}
