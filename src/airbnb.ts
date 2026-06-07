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
type Collision = { airbnbStart: string; airbnbEnd: string; bookingName: string; bookingEmail: string; bookingStart: string; bookingEnd: string };

export async function syncAirbnb(icalUrl: string): Promise<{ imported: number; collisions: Collision[] }> {
  if (!icalUrl) return { imported: 0, collisions: [] };

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

  // Sjekk at vi faktisk fikk en iCal-fil og ikke en HTML-side / feilmelding
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('Svaret fra Airbnb var ikke en gyldig kalender. Sjekk at iCal-lenken er riktig og fortsatt aktiv.');
  }
  const veventCount = (text.match(/BEGIN:VEVENT/g) || []).length;

  const data = ical.parseICS(text);
  const rows: { start_date: string; end_date: string; source: string; uid: string; summary: string }[] = [];
  // realGuestRanges: kun ekte Airbnb-gjester (ikke manuelle "Not available"-blokkeringer)
  const realGuestRanges: { start: string; end: string }[] = [];
  for (const k of Object.keys(data)) {
    const ev: any = data[k];
    if (ev.type !== 'VEVENT') continue;
    if (!ev.start || !ev.end) continue;
    const start = toISODate(new Date(ev.start));
    const end = toISODate(new Date(ev.end));
    const summary = String(ev.summary ?? '');
    const desc = String(ev.description ?? '');
    // Ekte gjest: Airbnb skriver "Reserved" og legger ved reservasjonsdetaljer (DESCRIPTION).
    // Manuell blokkering: "Not available" / "Blocked", uten reservasjonsdetaljer.
    const isManualBlock = /not available|blocked/i.test(summary) ||
      (!/reserved/i.test(summary) && !/reservation/i.test(desc));
    if (!isManualBlock) {
      realGuestRanges.push({ start, end });
    }
    rows.push({
      start_date: start,
      end_date: end,
      source: 'airbnb',
      uid: String(ev.uid ?? `${start}_${end}`),
      summary: 'Airbnb',
    });
  }

  // Hvis filen hadde VEVENT-er men vi fikk 0 rader, er det en parse-feil verdt å vite om
  if (veventCount > 0 && rows.length === 0) {
    throw new Error(`Fant ${veventCount} perioder i kalenderen, men klarte ikke å lese datoene. Kontakt support.`);
  }

  // Finn kollisjoner: KUN ekte Airbnb-gjester som overlapper bekreftede interne bookinger.
  // Manuelle "Not available"-blokkeringer ignoreres (de stammer ofte fra våre egne interne bookinger).
  const collisions: Collision[] = [];
  const { data: confirmed } = await supabase
    .from('bookings')
    .select('check_in,check_out,name,email')
    .eq('status', 'confirmed');
  for (const ab of realGuestRanges) {
    for (const bk of confirmed ?? []) {
      // halvåpne intervaller [start,end) overlapper hvis start1 < end2 og start2 < end1
      if (ab.start < bk.check_out && bk.check_in < ab.end) {
        collisions.push({
          airbnbStart: ab.start, airbnbEnd: ab.end,
          bookingName: bk.name, bookingEmail: bk.email,
          bookingStart: bk.check_in, bookingEnd: bk.check_out,
        });
      }
    }
  }

  // Erstatt alle eksisterende airbnb-rader med de ferske (enkelt og robust)
  const { error: delErr } = await supabase.from('blocked_dates').delete().eq('source', 'airbnb');
  if (delErr) throw new Error('Databasefeil ved sletting av gamle Airbnb-datoer: ' + delErr.message);
  if (rows.length) {
    const { error } = await supabase.from('blocked_dates').insert(rows);
    if (error) throw new Error('Databasefeil ved lagring: ' + error.message);
  }
  return { imported: rows.length, collisions };
}

