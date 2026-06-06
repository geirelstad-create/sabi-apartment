import ical from 'node-ical';
import { supabase } from './supabase.js';

function toISODate(d: Date): string {
  // Bruk UTC – Airbnb sender heldags-datoer som UTC midnatt, og Render kjører i UTC.
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Henter Airbnb iCal-kalenderen og oppdaterer blocked_dates (source='airbnb').
 * iCal VEVENT har DTSTART (innsjekk) og DTEND (utsjekk, eksklusiv) – samme modell som vår.
 *
 * Airbnb blokkerer forespørsler uten en nettleserlignende User-Agent, så vi henter
 * teksten selv med fetch og sender den til ical.parseICS (mer robust enn fromURL).
 */
export async function syncAirbnb(icalUrl: string): Promise<{ imported: number }> {
  if (!icalUrl) return { imported: 0 };

  const resp = await fetch(icalUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SabiApartmentBooking/1.0; +https://www.sabi-apartment.no)',
      'Accept': 'text/calendar, text/plain, */*',
    },
    redirect: 'follow',
  });
  if (!resp.ok) {
    throw new Error(`Airbnb svarte ${resp.status} ${resp.statusText}. iCal-lenken kan være feil, eller Airbnb blokkerer serveren.`);
  }
  const text = await resp.text();
  const data = ical.parseICS(text);

  const rows: { start_date: string; end_date: string; source: string; uid: string; summary: string }[] = [];
  for (const k of Object.keys(data)) {
    const ev: any = data[k];
    if (ev.type !== 'VEVENT') continue;
    if (!ev.start || !ev.end) continue;
    rows.push({
      start_date: toISODate(new Date(ev.start)),
      end_date: toISODate(new Date(ev.end)),
      source: 'airbnb',
      uid: String(ev.uid ?? `${toISODate(new Date(ev.start))}_${toISODate(new Date(ev.end))}`),
      summary: 'Airbnb',
    });
  }

  // Erstatt alle eksisterende airbnb-rader med de ferske (enkelt og robust)
  await supabase.from('blocked_dates').delete().eq('source', 'airbnb');
  if (rows.length) {
    const { error } = await supabase.from('blocked_dates').insert(rows);
    if (error) throw error;
  }
  return { imported: rows.length };
}

