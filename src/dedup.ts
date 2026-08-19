/**
 * Normalization is the whole dedup strategy — companies.domain,
 * phone_normalized, and address_normalized all have (partial) unique
 * indexes in Postgres, so a plain upsert against the right conflict
 * target does the actual dedup work. This module just produces
 * consistent normalized values so those indexes can do their job.
 */

export function normalizeDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  // Strip a leading US country code so (602) 555-0100 and +1 602-555-0100
  // normalize to the same value.
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits || null;
}

export function normalizeAddress(address: string | null): string | null {
  if (!address) return null;
  return address
    .toLowerCase()
    .replace(/[.,#]/g, "")
    .replace(/\bsuite\b|\bste\b|\bunit\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
