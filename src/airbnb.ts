import ical from 'node-ical';
import { supabase } from './supabase.js';

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Henter Airbnb iCal-kalenderen og oppdaterer blocked_dates (source='airbnb').
 * iCal VEVENT har DTSTART (innsjekk) og DTEND (utsjekk, eksklusiv) – samme modell som vår.
 */
export async function syncAirbnb(icalUrl: string): Promise<{ imported: number }> {
  if (!icalUrl) return { imported: 0 };

  const data = await ical.async.fromURL(icalUrl);
  const rows: { start_date: string; end_date: string; source: string; uid: string; summary: string }[] = [];

  for (const k of Object.keys(data)) {
    const ev: any = data[k];
    if (ev.type !== 'VEVENT') continue;
    if (!ev.start || !ev.end) continue;
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    rows.push({
      start_date: toISODate(start),
      end_date: toISODate(end),
      source: 'airbnb',
      uid: String(ev.uid ?? `${toISODate(start)}_${toISODate(end)}`),
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
