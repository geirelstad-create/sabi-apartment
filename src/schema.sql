-- Sabi Apartment (Nextron Duquesa) – databaseskjema
-- Kjør i Supabase SQL Editor.

create extension if not exists "pgcrypto";

-- Bookinger fra ansatte
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  check_in date not null,
  check_out date not null,
  name text not null,
  email text not null,
  guests int not null default 1,
  message text,
  lang text not null default 'no',
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  verify_token text unique,
  verify_expires timestamptz,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint booking_date_order check (check_out > check_in)
);
create index if not exists bookings_range_idx on bookings (check_in, check_out, status);

-- Blokkerte datoer importert fra Airbnb iCal (eller andre eksterne kalendere)
-- Disse blandes med bekreftede bookinger for å vise opptatt-status.
create table if not exists blocked_dates (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,          -- eksklusiv (utsjekk-dato)
  source text not null default 'airbnb',
  uid text,                        -- iCal UID for å unngå duplikater
  summary text,
  created_at timestamptz not null default now()
);
create unique index if not exists blocked_uid_idx on blocked_dates (source, uid);
create index if not exists blocked_range_idx on blocked_dates (start_date, end_date);

-- Innhold / CMS (én rad). Lagrer infotekst (JSON), Airbnb iCal-URL og nøkkelboks-kode.
create table if not exists content (
  id int primary key default 1,
  info jsonb,                      -- { no:[...], en:[...] }
  airbnb_ical_url text,
  keybox_code text default '',     -- sendes i bekreftelses-e-post, vises ikke offentlig
  updated_at timestamptz not null default now(),
  constraint content_singleton check (id = 1)
);

insert into content (id, info, airbnb_ical_url, keybox_code)
values (1, null, null, '')
on conflict (id) do nothing;
