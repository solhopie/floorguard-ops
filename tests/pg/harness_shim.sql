-- Run 9 local validation harness: Supabase-provided pieces that do not exist
-- in a bare PostgreSQL 16 cluster. Run BEFORE migrations 0001-0010.

-- Roles referenced by migration grants.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit;
  end if;
end $$;

grant usage on schema public to authenticated, anon;

-- auth.uid(): in Supabase this comes from the JWT. Locally it reads the
-- request.jwt.claim.sub GUC, which tests set per simulated user.
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

-- storage schema: buckets/objects tables + foldername() helper.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  metadata jsonb,
  unique (bucket_id, name)
);
create or replace function storage.foldername(p_name text)
returns text[] language sql immutable as $$
  select string_to_array(p_name, '/')
$$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, anon;
grant all on storage.buckets, storage.objects to authenticated;
