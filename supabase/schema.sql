create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

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

alter table public.clients add column if not exists email text not null default '';
alter table public.clients add column if not exists reminders boolean not null default true;

create table if not exists public.emails (
  id              uuid primary key default gen_random_uuid(),
  owner           uuid not null default auth.uid() references auth.users on delete cascade,
  client_id       uuid not null references public.clients on delete cascade,
  appointment_id  uuid references public.appointments on delete set null,
  kind            text not null check (kind in ('confirmation', 'reminder', 'nudge')),
  starts_at       timestamptz,
  to_email        text not null,
  ses_message_id  text,
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists emails_client_id_idx on public.emails (client_id);
create unique index if not exists emails_one_reminder_idx on public.emails (appointment_id, starts_at) where kind = 'reminder';

alter table public.clients enable row level security;
alter table public.cuts    enable row level security;
alter table public.photos  enable row level security;
alter table public.appointments enable row level security;
alter table public.emails  enable row level security;

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

drop policy if exists "Owner only" on public.emails;
create policy "Owner only" on public.emails for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

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
