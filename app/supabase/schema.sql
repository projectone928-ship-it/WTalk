-- Run this in Supabase Dashboard → SQL Editor.
-- Create a private Storage bucket named: wtalk-pin-voices

create table if not exists public.wtalk_users (
  channel_name text not null,
  username text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (channel_name, username)
);

create table if not exists public.wtalk_pin_voices (
  id uuid primary key,
  channel_name text not null,
  username text not null,
  title text not null check (char_length(title) between 1 and 120),
  duration_seconds integer not null default 0 check (duration_seconds between 1 and 60),
  file_size bigint not null check (file_size > 0 and file_size <= 5242880),
  mime_type text not null,
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_name, username)
);

create index if not exists wtalk_pin_voices_channel_idx
  on public.wtalk_pin_voices (channel_name, created_at desc);

create index if not exists wtalk_users_last_seen_idx
  on public.wtalk_users (last_seen_at);

-- The server uses SUPABASE_SERVICE_ROLE_KEY and performs all access checks.
-- Keep the bucket private and never expose the service-role key to Android.
-- Optional extra hardening for client-side access:
alter table public.wtalk_users enable row level security;
alter table public.wtalk_pin_voices enable row level security;
