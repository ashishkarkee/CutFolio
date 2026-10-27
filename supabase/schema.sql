-- CutFolio database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run.
-- Safe to run more than once.

-- Clients -------------------------------------------------------------------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Cuts (each one is also a transaction) -------------------------------------
create table if not exists public.cuts (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  client_id   uuid not null references public.clients on delete cascade,
  date        timestamptz not null default now(),
  price       numeric(10, 2) not null default 0,
  minutes     integer not null default 0,
  style       text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists cuts_client_id_idx on public.cuts (client_id);
create index if not exists cuts_date_idx on public.cuts (date);

-- Photos (files live in the private "photos" storage bucket) ----------------
create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  cut_id      uuid not null references public.cuts on delete cascade,
  client_id   uuid not null references public.clients on delete cascade,
  path        text not null,
  thumb_path  text not null,
  created_at  timestamptz not null default now()
);
create index if not exists photos_cut_id_idx on public.photos (cut_id);

-- Appointments (the schedule). cut_id is set once the booked cut is logged.
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

-- Only the signed-in owner can see or change their own rows ------------------
alter table public.clients enable row level security;
alter table public.cuts    enable row level security;
alter table public.photos  enable row level security;
alter table public.appointments enable row level security;

drop policy if exists "Owner only" on public.clients;
create policy "Owner only" on public.clients for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

drop policy if exists "Owner only" on public.cuts;
create policy "Owner only" on public.cuts for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

drop policy if exists "Owner only" on public.photos;
create policy "Owner only" on public.photos for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

drop policy if exists "Owner only" on public.appointments;
create policy "Owner only" on public.appointments for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- Private photo bucket. Files are stored under <user id>/..., and each user
-- can only touch their own folder.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "CutFolio photos select" on storage.objects;
create policy "CutFolio photos select" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "CutFolio photos insert" on storage.objects;
create policy "CutFolio photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "CutFolio photos delete" on storage.objects;
create policy "CutFolio photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
