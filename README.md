# Forge Outbound — automated HVAC cold-email pipeline

Finds HVAC businesses via Google Places → dedupes → finds a decision-maker + verified email via Apollo → scores the lead → researches their website → writes a personalized email with AI → sends it → follows up automatically → stops on reply/bounce/unsubscribe. Runs once a day via Vercel Cron.

Full requirements/reasoning behind every decision here live in Claude's memory (`project_forge_outbound_leadgen.md`) if this file ever needs re-deriving.

## Architecture

```
Google Places (Text Search, cheap fields)
  -> filter to real HVAC candidates
  -> Google Places (Details, phone/website/rating — only for candidates)
  -> dedupe (domain / phone / address) -> Supabase `companies`
  -> Apollo (decision-maker + verified email) -> `contacts`
  -> deterministic scoring (0-100) -> gate at 60
  -> website research (plain fetch + heuristics, no fabrication risk)
  -> OpenAI (structured output, evidence-only) -> `research`
  -> Resend (send) -> `outreach`
  -> Resend webhook (delivered/bounced/complained/opened) -> updates `outreach`
  -> IMAP poll of the reply inbox (once/day) -> replies/unsubscribes -> `suppressions`
  -> follow-up scheduler (day 3/7/14, template-based) -> back to Resend
```

Every stage reads/writes its own table columns rather than running as one atomic function — the daily cron can pick up wherever yesterday's run left off.

## Why these specific tools (the free/cheap-first reasoning)

- **Google Places, not Yelp**: Yelp Fusion has no free tier ($7.99+/1,000 calls) *and* its ToS prohibits building a persistent competing business database and requires purging cached data within 24 hours — directly incompatible with the permanent `companies` table this needs. Google Places gives 5,000 free Text Search calls/month, which is why sourcing is built as a two-stage fetch (cheap Basic Data search, then Details only for real candidates) — that's the actual cost control, not a detail.
- **Apollo over Hunter**: Apollo's free tier is meaningfully more generous for both finding a decision-maker and revealing their email.
- **Resend over Amazon SES**: SES will get your account suspended for unsolicited/cold email — it's built for transactional mail only. Resend's free tier (3,000/mo, 100/day) matches the 10-25/day starting volume.
- **Supabase**: per your stack preference, plain Postgres, free tier is plenty at this scale.
- **No dedicated "cold email SaaS"** (Instantly/Smartlead/etc.) — deliberately avoided per your "don't recommend unnecessary SaaS tools" instruction. Revisit only if Resend's deliverability genuinely proves insufficient at higher volume.

## Domain setup — read this before sending anything

**Use a dedicated domain, not weforgedigitalai.com directly.** If a cold-sending domain's reputation degrades (a bad subject line, a spam-trap hit, whatever), you don't want that bleeding into the deliverability of Forge's actual business email. A cheap secondary domain (~$10-15/year, e.g. `forgedigitalai.email` or similar) fully isolates that risk. A *subdomain* of weforgedigitalai.com is a middle option — some isolation, cheaper (free), but not as clean; a fully separate domain is the safer practical choice per the spec's own ask, and what's assumed below.

You'll need, on that domain:
1. **SPF, DKIM, DMARC records** — Resend's dashboard gives you the exact DNS records to add once you connect the domain there.
2. **A real receiving inbox** at the same address used for `OUTBOUND_REPLY_TO` — Resend only sends, it doesn't receive, and reply detection needs somewhere real to poll. **Recommended: Zoho Mail's free tier** (free for 1 custom domain, up to 5 users) — set it up, then use its IMAP credentials for `IMAP_HOST`/`IMAP_USER`/`IMAP_PASSWORD` in `.env`.
3. **Warm-up**: don't start at `DAILY_SEND_CAP=15` on day one of a brand-new domain — see Scaling below.

## Accounts you need to create (I can't do this part — account creation is off-limits for me even for free tiers)

| Service | What for | Plan |
|---|---|---|
| [Google Cloud Console](https://console.cloud.google.com) | Places API (New) | Free tier, but needs a billing account attached |
| [Apollo.io](https://apollo.io) | Contact enrichment | Free |
| [Resend](https://resend.com) | Sending | Free (3,000/mo) |
| [Zoho Mail](https://zoho.com/mail) | Receiving replies on the outbound domain | Free |
| A domain registrar (Namecheap, Cloudflare, etc.) | The dedicated outbound domain | ~$10-15/yr |
| [Supabase](https://supabase.com) | Database | Free |

Once you've got API keys from each, hand them to me and I'll fill in `.env`/Vercel env vars and do the deploy — same pattern as the SDR chatbot project.

## Free MVP — what $0 actually gets you

- 5,000 Google Places Text Search calls/month → far more than enough to search 3 cities × 4-5 keywords daily without hitting the cap
- Apollo free tier → roughly enough decision-maker lookups for the 10-25/day target volume
- Resend free tier → exactly matches a 15/day starting cap (100/day ceiling)
- Supabase, Zoho Mail free tiers → no realistic ceiling at this scale
- **The only real cost is the domain** (~$10-15/year) — everything else genuinely runs at $0/month at MVP volume.

## Paid upgrade path

Per your stated priority order (lead quality → contact accuracy → email verification → deliverability → automation → scale):

- **$25/mo**: Apollo paid tier (more/better contact data, real email verification instead of relying on Apollo's own status field) — directly improves contact accuracy and reduces bounce risk, the two things that most protect deliverability long-term.
- **$50/mo**: add Resend's paid tier (higher daily send limit, needed once you're consistently past 100/day) + a dedicated email-verification service (NeverBounce or ZeroBounce) as a second check before every send — squeezes bounce rate further, which is the single biggest lever on domain reputation.
- **$100/mo**: a second warmed-up sending domain/inbox (splits volume, reduces per-domain velocity, standard practice once you're pushing toward 250/day) + Google Places budget headroom if you expand past a handful of cities.

## Testing plan — do this before any real send

1. `pnpm typecheck` — clean as of this build.
2. `pnpm run-pipeline` locally with real API keys but **`DAILY_SEND_CAP=0`** in `.env` — this exercises sourcing → dedup → enrichment → scoring → research → AI generation end-to-end and writes everything to Supabase *except* actually calling Resend. Inspect the `research` and would-be `outreach` content directly in Supabase's table editor before trusting it.
3. Set `DAILY_SEND_CAP=1` and point `TARGET_CITIES`/`TARGET_KEYWORDS` at something narrow, then send **exactly one real email — to yourself** (a company/contact row you insert manually with your own email) before ever targeting a real prospect. Check subject/body/headers/unsubscribe link land correctly.
4. Reply to that test email from a different address and re-run the pipeline — confirm `checkForRepliesAndUnsubscribes` actually finds it and stops that sequence.
5. Only then raise `DAILY_SEND_CAP` and point at real target cities.

## Deployment

```bash
cd /Users/babyjupiter/forge-outbound
git add -A && git commit -m "Initial forge-outbound scaffold"
gh repo create forge-outbound --private --source=. --remote=origin
git push -u origin main
npx vercel link
# then: npx vercel env add <EACH_VAR_FROM_.ENV.EXAMPLE> production
npx vercel deploy --prod
```

Then run the Supabase migration (`supabase/migrations/0001_init.sql`) against your Supabase project — either via the Supabase SQL editor (paste the file's contents) or the Supabase CLI.

## Scaling — 10-25/day → 250/day

Never just raise `DAILY_SEND_CAP`. Volume and infrastructure need to grow together:

- **10-25/day** (weeks 1-2): the dedicated domain warming up, one Resend account, `DAILY_SEND_CAP=15`.
- **50/day** (once bounce rate is consistently low and you've had real replies, not just silence): raise the cap gradually — roughly +5/day per week, not a jump.
- **100/day**: you're at Resend's free daily ceiling — this is the natural point to move to Resend's paid tier and add a real verification service (see $50/mo tier above), since bounce rate matters more as volume grows.
- **250/day**: needs a second sending domain/inbox splitting volume, so no single domain's velocity looks anomalous. Also revisit the Google Places search breadth (more cities) and Apollo volume at this point.

Reputation, not sending capacity, is the actual bottleneck at every stage — the send cap should always trail slightly behind what the domain has proven it can handle, not lead it.
