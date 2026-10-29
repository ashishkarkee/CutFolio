-- CutFolio email reminders: client emails and a log of every email sent.
-- Paste into Supabase → SQL Editor → New query, then press Run. Safe to run more than once.
-- (Already included in schema.sql for new setups.)
alter table public.clients add column if not exists email text not null default '';
-- Turned off when a client taps "unsubscribe" in an email
alter table public.clients add column if not exists reminders boolean not null default true;

-- One row per email. The AWS Lambda writes these; the app reads them to show
-- what was sent on each profile and booking.
create table if not exists public.emails (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null default auth.uid() references auth.users on delete cascade,
  client_id       uuid not null references public.clients on delete cascade,
  appointment_id  uuid references public.appointments on delete set null,
  kind            text not null check (kind in ('confirmation', 'reminder', 'nudge')),
  starts_at       timestamptz,          -- the booking time a confirmation or reminder was about
  to_email        text not null,
  ses_message_id  text,
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists emails_client_id_idx on public.emails (client_id);
-- At most one 24-hour reminder per booking time, even if two runs overlap
create unique index if not exists emails_one_reminder_idx on public.emails (appointment_id, starts_at) where kind = 'reminder';

alter table public.emails enable row level security;

drop policy if exists "Owner only" on public.emails;
create policy "Owner only" on public.emails for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
