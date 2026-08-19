import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

// Service-role client — this runs entirely server-side (cron job), never
// exposed to a browser, so RLS bypass here is intentional, not an oversight.
export const db = createClient(url, key, {
  auth: { persistSession: false },
});
