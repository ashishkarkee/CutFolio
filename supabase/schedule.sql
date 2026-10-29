create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  client_id   uuid not null references public.clients on delete cascade,
  starts_at   timestamptz not null,
  minutes     integer not null default 30,
  notes       text not null default '',
  cut_id      uuid references public.cuts on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists appointments_starts_at_idx on public.appointments (starts_at);

alter table public.appointments enable row level security;

drop policy if exists "Owner only" on public.appointments;
create policy "Owner only" on public.appointments for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
