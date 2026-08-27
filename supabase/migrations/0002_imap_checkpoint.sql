-- Tracks the highest IMAP UID already processed in the reply-check
-- inbox, replacing reliance on the \Seen flag.
--
-- Why: the reply inbox is the user's own actively-used personal Gmail
-- (ImprovMX forwards here) — if they read a reply themselves in the
-- normal course of checking email, it stops being "unseen" and the
-- old seen:false-based check would silently never detect that reply
-- again. UIDs only ever increase and are unaffected by the user
-- reading mail, so a persisted high-water-mark is immune to that race.
create table imap_checkpoint (
  id boolean primary key default true,
  last_uid bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint imap_checkpoint_singleton check (id = true)
);

insert into imap_checkpoint (id, last_uid) values (true, 0);
