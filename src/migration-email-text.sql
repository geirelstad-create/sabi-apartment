-- Kjør denne i Supabase SQL Editor hvis du allerede har kjørt schema.sql tidligere.
-- Legger til kolonnen for ekstra e-posttekst i bekreftelsesmailen.
alter table content add column if not exists email_text jsonb;
