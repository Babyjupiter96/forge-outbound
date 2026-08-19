import type { RawBusinessListing } from "../types.js";

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * Two-stage fetch, deliberately — this is the actual cost-control
 * mechanism, not an implementation detail. Places API (New) bills the
 * *entire* call at whichever field's SKU tier is highest. Text Search
 * requesting only Basic Data fields (id/name/address) is cheap; the
 * same call requesting websiteUri or phone jumps the whole call to the
 * Contact Data tier. So: search cheap for everything, then spend the
 * pricier Place Details call only on candidates worth enriching.
 */
interface BasicPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  types?: string[];
}

interface DetailedPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: { text: string };
  googleMapsUri?: string;
}

async function searchTextBasic(query: string): Promise<BasicPlace[]> {
  if (!API_KEY) throw new Error("GOOGLE_PLACES_API_KEY not set");

  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      // Basic Data SKU only — id, displayName, formattedAddress, types.
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.types",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 20 }),
  });

  if (!res.ok) {
    throw new Error(`Places searchText failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { places?: BasicPlace[] };
  return data.places ?? [];
}

async function getPlaceDetails(placeId: string): Promise<DetailedPlace | null> {
  if (!API_KEY) throw new Error("GOOGLE_PLACES_API_KEY not set");

  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": API_KEY,
      // Contact Data (phone, website) + Atmosphere Data (rating) — only
      // called for candidates that already passed the type/keyword filter.
      "X-Goog-FieldMask":
        "id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,userRatingCount,editorialSummary,googleMapsUri",
    },
  });

  if (!res.ok) {
    console.error(`Place details failed for ${placeId}: ${res.status}`);
    return null;
  }
  return (await res.json()) as DetailedPlace;
}

const HVAC_TYPE_HINTS = ["hvac_contractor", "general_contractor", "plumber", "electrician"];

function looksLikeHvac(place: BasicPlace, keyword: string): boolean {
  const name = place.displayName?.text?.toLowerCase() ?? "";
  const types = place.types ?? [];
  if (types.some((t) => HVAC_TYPE_HINTS.includes(t))) return true;
  // Google's type taxonomy for HVAC is inconsistent enough that name/keyword
  // matching genuinely does useful additional filtering here, not just
  // redundant belt-and-suspenders.
  return name.includes("hvac") || name.includes("heating") || name.includes("cooling") || name.includes("air conditioning");
}

/**
 * Searches one city+keyword combo and returns full listings only for
 * results that look like actual HVAC businesses — this is the filter
 * that keeps Place Details spend proportional to real candidates.
 */
export async function searchHvacBusinesses(city: string, state: string, keyword: string): Promise<RawBusinessListing[]> {
  const basicResults = await searchTextBasic(`${keyword} in ${city}, ${state}`);
  const candidates = basicResults.filter((p) => looksLikeHvac(p, keyword));

  const listings: RawBusinessListing[] = [];
  for (const candidate of candidates) {
    const details = await getPlaceDetails(candidate.id);
    if (!details) continue;
    listings.push({
      name: details.displayName?.text ?? candidate.displayName?.text ?? "Unknown",
      website: details.websiteUri ?? null,
      phone: details.nationalPhoneNumber ?? null,
      address: details.formattedAddress ?? candidate.formattedAddress ?? null,
      city,
      state,
      googlePlaceId: details.id,
      googleMapsUrl: details.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${details.id}`,
      rating: details.rating ?? null,
      reviewCount: details.userRatingCount ?? null,
      businessDescription: details.editorialSummary?.text ?? null,
    });
  }
  return listings;
}
