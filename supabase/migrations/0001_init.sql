-- Forge Outbound — initial schema.
--
-- Design notes (why it's shaped this way):
-- * `domain` is the primary dedup key wherever a business has a website —
--   far more reliable than name matching. `phone_normalized` and
--   `address_normalized` back it up for businesses with no website.
-- * Every stage of the pipeline (source -> enrich -> verify -> score ->
--   research -> generate -> send) reads/writes its own table or its own
--   columns, so the pipeline can resume from wherever it left off instead
--   of needing to run atomically end-to-end.
-- * `suppressions` is checked before every single send, independent of
--   sequence state — a global do-not-contact list survives even if a
--   company record is later deleted/recreated by dedup.

create extension if not exists pgcrypto;

create type company_status as enum (
  'new',            -- just ingested from Google Places, not yet enriched
  'enriching',
  'no_contact_found',
  'ready',          -- scored, has a verified contact, eligible to email
  'below_threshold',-- scored too low to contact automatically
  'queued',
  'active',         -- sequence in progress
  'replied',
  'bounced',
  'unsubscribed',
  'not_interested',
  'sequence_complete',
  'suppressed'
);

create type email_verification_status as enum ('unverified', 'valid', 'risky', 'invalid');

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text,
  domain text,                          -- normalized, lowercased, no www/protocol — primary dedup key
  phone text,
  phone_normalized text,                -- digits only — secondary dedup key
  address text,
  address_normalized text,              -- lowercased/stripped — tertiary dedup key
  city text,
  state text,
  industry text default 'HVAC',
  google_place_id text unique,
  google_maps_url text,
  rating numeric(2,1),
  review_count int,
  service_area text,
  business_description text,
  source text not null default 'google_places',
  lead_score int,                       -- 0-100, see src/scoring.ts
  lead_tier text,                       -- 'high' | 'medium' | 'low'
  status company_status not null default 'new',
  status_reason text,                   -- why it's in this status (esp. below_threshold / no_contact_found)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Partial unique indexes: NULLs don't collide, so a company missing a
-- website (no domain) or phone doesn't falsely dedupe against another
-- company that's also missing one.
create unique index companies_domain_key on companies (domain) where domain is not null;
create index companies_phone_idx on companies (phone_normalized) where phone_normalized is not null;
create index companies_address_idx on companies (address_normalized) where address_normalized is not null;
create index companies_status_idx on companies (status);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  first_name text,
  last_name text,
  title text,
  email text,
  email_verification_status email_verification_status not null default 'unverified',
  linkedin_url text,
  confidence_score numeric(3,2),        -- 0.00-1.00, from the enrichment provider
  enrichment_source text,               -- e.g. 'apollo'
  created_at timestamptz not null default now()
);

create unique index contacts_company_email_key on contacts (company_id, email) where email is not null;
create index contacts_company_idx on contacts (company_id);

create table research (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  website_observations jsonb,           -- structured notes: has_chat, has_booking, has_lead_form, review_snippets, etc.
  pain_point text,                      -- the ONE evidence-based observation the AI is allowed to use
  recommended_service text,             -- single Forge service this prospect gets pitched
  evidence text,                        -- what on the site/listing actually supports pain_point (audit trail against fabrication)
  researched_at timestamptz not null default now()
);

create index research_company_idx on research (company_id);

create type outreach_status as enum (
  'queued', 'sent', 'delivered', 'bounced', 'complained', 'opened', 'replied'
);

create table outreach (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  campaign text not null default 'hvac-v1',
  sequence_step int not null,           -- 0 = initial, 1/2/3 = follow-ups
  subject text not null,
  body text not null,
  resend_email_id text,                 -- Resend's id, for matching webhook events back
  status outreach_status not null default 'queued',
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);

create index outreach_company_idx on outreach (company_id);
create index outreach_contact_idx on outreach (contact_id);
create index outreach_status_idx on outreach (status);
create unique index outreach_resend_id_key on outreach (resend_email_id) where resend_email_id is not null;

-- Global do-not-contact list. Checked before every send regardless of
-- company/contact status — this is the actual compliance backstop.
create table suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  reason text not null,                 -- 'unsubscribed' | 'bounced' | 'complained' | 'manual' | 'not_interested'
  created_at timestamptz not null default now()
);

-- Tracks which (city, keyword) search combos have already been run
-- against Google Places, and when — so the pipeline expands into new
-- ground each run instead of re-spending API calls on the same search.
create table source_searches (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  keyword text not null,
  last_run_at timestamptz,
  result_count int,
  unique (city, keyword)
);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger companies_set_updated_at
  before update on companies
  for each row execute function set_updated_at();
