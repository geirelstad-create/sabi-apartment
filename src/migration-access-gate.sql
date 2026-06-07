-- Kjør i Supabase SQL Editor hvis du allerede har kjørt schema.sql tidligere.
-- Legger til tilgangsport (engangslenker) og ekstra godkjente e-poster.

alter table content add column if not exists allowed_emails jsonb default '[]'::jsonb;

create table if not exists access_tokens (
  token text primary key,
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists access_tokens_email_idx on access_tokens (email);
