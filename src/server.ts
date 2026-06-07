import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { supabase } from './supabase.js';
import { sendVerificationEmail, sendConfirmedEmail, sendAccessEmail, sendCollisionAlert } from './mailer.js';
import { syncAirbnb } from './airbnb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.PUBLIC_URL }));
app.use(express.json({ limit: '1mb' }));

// Hold siden ute av søkemotorer (bedriftsintern – skal ikke indekseres)
app.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});

// ---------- Hjelpere ----------
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nights(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function maxDateISO(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + config.MAX_MONTHS_AHEAD);
  return d.toISOString().slice(0, 10);
}
function emailAllowed(email: string): boolean {
  const dom = email.trim().toLowerCase().split('@')[1] ?? '';
  return config.ALLOWED_DOMAINS.includes(dom);
}

// Henter ekstra godkjente e-poster (utenfor Nextron) fra content
async function getAllowedExtraEmails(): Promise<string[]> {
  const { data } = await supabase.from('content').select('allowed_emails').eq('id', 1).single();
  const arr = (data?.allowed_emails as any) ?? [];
  return Array.isArray(arr) ? arr.map((e: string) => String(e).trim().toLowerCase()) : [];
}

// Får denne e-posten lov (Nextron-domene ELLER ekstra godkjent adresse)?
async function emailMayAccess(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (emailAllowed(e)) return true;
  const extra = await getAllowedExtraEmails();
  return extra.includes(e);
}

// ---- Adgangsbillett (signert med HMAC, lagres som cookie) ----
function makeTicket(email: string): string {
  const exp = Date.now() + config.ACCESS_TICKET_DAYS * 86400 * 1000;
  const payload = `${email.toLowerCase()}|${exp}`;
  const sig = createHmac('sha256', config.ACCESS_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}
function verifyTicket(ticket: string): boolean {
  try {
    const decoded = Buffer.from(ticket, 'base64url').toString('utf8');
    const [email, exp, sig] = decoded.split('|');
    if (!email || !exp || !sig) return false;
    if (Number(exp) < Date.now()) return false;
    const expected = createHmac('sha256', config.ACCESS_SECRET).update(`${email}|${exp}`).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
function getCookie(req: express.Request, name: string): string | null {
  const raw = req.header('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function hasValidTicket(req: express.Request): boolean {
  const t = getCookie(req, 'sabi_access');
  return t ? verifyTicket(t) : false;
}

// Sjekk om [checkIn, checkOut) overlapper en bekreftet/avventende booking eller blokkert dato
async function rangeAvailable(checkIn: string, checkOut: string, ignoreBookingId?: string): Promise<boolean> {
  // Bookinger som opptar plass: confirmed + pending (ikke utløpt)
  const { data: bk } = await supabase
    .from('bookings')
    .select('id,check_in,check_out,status,verify_expires')
    .in('status', ['pending', 'confirmed']);
  for (const b of bk ?? []) {
    if (ignoreBookingId && b.id === ignoreBookingId) continue; // ikke kollider med seg selv
    if (b.status === 'pending' && b.verify_expires && new Date(b.verify_expires) < new Date()) continue; // utløpt hold
    if (checkIn < b.check_out && b.check_in < checkOut) return false;
  }
  const { data: bl } = await supabase.from('blocked_dates').select('start_date,end_date');
  for (const d of bl ?? []) {
    if (!d.start_date || !d.end_date) continue; // hopp over ev. ugyldige rader
    if (checkIn < d.end_date && d.start_date < checkOut) return false;
  }
  return true;
}

function adminOk(req: express.Request): boolean {
  const expected = config.ADMIN_PASSWORD;
  if (!expected) return false;
  const got = req.header('x-admin-password') || '';
  const a = Buffer.from(got), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// Initialer fra navn: "Geir Elstad" -> "GE", "Ola" -> "OL"
function initialsFromName(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Landkode (ISO) fra Nextron-e-postdomenet -> brukes til flagg i frontend
function countryFromEmail(email: string): string | null {
  const dom = (email || '').toLowerCase().split('@')[1] ?? '';
  if (dom.endsWith('.no')) return 'NO';
  if (dom.endsWith('.se')) return 'SE';
  if (dom.endsWith('.dk')) return 'DK';
  if (dom.endsWith('.fi')) return 'FI';
  return null;
}

// ---------- Tilgangsport: be om lenke ----------
app.post('/api/access/request', async (req, res) => {
  const Body = z.object({ email: z.string().email(), lang: z.enum(['no', 'en']).default('no') });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ugyldig e-post' });
  const email = parsed.data.email.trim().toLowerCase();

  // Svar alltid 200 (ikke avslør om en adresse finnes/er godkjent)
  if (await emailMayAccess(email)) {
    const token = randomUUID();
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await supabase.from('access_tokens').insert({ token, email, expires_at: expires });
    try {
      await sendAccessEmail({ to: email, lang: parsed.data.lang, token });
    } catch (e) { console.error('Kunne ikke sende tilgangslenke:', e); }
  }
  res.json({ ok: true });
});

// ---------- Tilgangsport: bruk lenke (setter cookie) ----------
app.get('/api/access/verify', async (req, res) => {
  const token = String(req.query.token ?? '');
  if (!token) return res.status(400).send(htmlPage('Ugyldig lenke', 'Lenken mangler en kode.'));
  const { data: row } = await supabase.from('access_tokens').select('*').eq('token', token).single();
  if (!row) return res.status(404).send(htmlPage('Ugyldig lenke', 'Lenken er ugyldig eller allerede brukt.'));
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).send(htmlPage('Lenken er utløpt', 'Be om en ny tilgangslenke på forsiden.'));
  }
  await supabase.from('access_tokens').update({ used_at: new Date().toISOString() }).eq('token', token);

  const ticket = makeTicket(row.email);
  const maxAge = config.ACCESS_TICKET_DAYS * 86400;
  res.setHeader('Set-Cookie', `sabi_access=${encodeURIComponent(ticket)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`);
  // Send brukeren til forsiden – cookien gjør at porten slipper dem inn
  res.redirect('/');
});

// ---------- Sjekk om nettleseren har gyldig adgangsbillett ----------
app.get('/api/access/check', (req, res) => {
  res.json({ access: hasValidTicket(req) });
});

// ---------- Admin: ekstra godkjente e-poster ----------
app.get('/api/admin/allowed-emails', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  res.json({ emails: await getAllowedExtraEmails() });
});
app.put('/api/admin/allowed-emails', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const Body = z.object({ emails: z.array(z.string().email()).max(200) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ugyldig liste' });
  const clean = Array.from(new Set(parsed.data.emails.map(e => e.trim().toLowerCase())));
  const { error } = await supabase.from('content').upsert({ id: 1, allowed_emails: clean, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, emails: clean });
});

// ---------- Admin: maskinoversettelse (no -> en) ----------
app.post('/api/admin/translate', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  if (!config.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Oversettelse er ikke konfigurert (mangler ANTHROPIC_API_KEY).' });
  }
  const source = req.body?.no;
  if (source === undefined) return res.status(400).json({ error: 'Mangler norsk tekst å oversette.' });

  try {
    const prompt = `Du er en profesjonell oversetter. Oversett verdiene i denne JSON-strukturen fra norsk til engelsk. ` +
      `Behold ALLE nøkler, struktur, HTML-tagger, lenker (href), telefonnumre, e-postadresser, koder og emojier nøyaktig som de er – oversett KUN den menneskelige teksten. ` +
      `Svar med KUN gyldig JSON, ingen forklaring, ingen markdown-kodeblokk.\n\nJSON:\n${JSON.stringify(source)}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `Oversettelsestjenesten svarte ${r.status}: ${t.slice(0, 200)}` });
    }
    const data: any = await r.json();
    let textOut = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    textOut = textOut.replace(/```json\s*|\s*```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(textOut); }
    catch { return res.status(502).json({ error: 'Klarte ikke å tolke oversettelsen. Prøv igjen.' }); }
    res.json({ en: parsed });
  } catch (e) {
    res.status(502).json({ error: 'Oversettelse feilet: ' + (e instanceof Error ? e.message : '') });
  }
});

// ---------- Admin: maskinoversettelse-status ----------
app.get('/api/admin/translate-available', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  res.json({ available: !!config.ANTHROPIC_API_KEY });
});

// ---------- Offentlig: ledighet (begrenset persondata: kun initialer + land) ----------
app.get('/api/availability', async (_req, res) => {
  try {
    const out: { start: string; end: string; source: string; initials?: string; country?: string | null }[] = [];
    const { data: bk } = await supabase
      .from('bookings')
      .select('check_in,check_out,status,verify_expires,name,email')
      .in('status', ['pending', 'confirmed']);
    for (const b of bk ?? []) {
      if (b.status === 'pending' && b.verify_expires && new Date(b.verify_expires) < new Date()) continue;
      out.push({
        start: b.check_in, end: b.check_out, source: 'booking',
        initials: initialsFromName(b.name), country: countryFromEmail(b.email),
      });
    }
    const { data: bl } = await supabase.from('blocked_dates').select('start_date,end_date,source');
    for (const d of bl ?? []) out.push({ start: d.start_date, end: d.end_date, source: d.source });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Feil' });
  }
});

// ---------- Offentlig: innhold (CMS) ----------
app.get('/api/content', async (_req, res) => {
  const { data } = await supabase.from('content').select('info,airbnb_ical_url').eq('id', 1).single();
  // NB: keybox_code returneres ALDRI offentlig
  res.json({ info: data?.info ?? null, airbnbIcalUrl: data?.airbnb_ical_url ?? '' });
});

// ---------- Opprett booking (pending + verifiserings-e-post) ----------
app.post('/api/bookings', async (req, res) => {
  const Body = z.object({
    checkIn: z.string().date(),
    checkOut: z.string().date(),
    name: z.string().min(2),
    email: z.string().email(),
    guests: z.number().int().min(1).max(6).default(1),
    message: z.string().max(1000).optional(),
    lang: z.enum(['no', 'en']).default('no'),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ugyldige felt' });
  const b = parsed.data;

  // Domenesjekk på server (frontend kan omgås) – Nextron-domene eller godkjent ekstra-adresse
  if (!(await emailMayAccess(b.email))) {
    return res.status(403).json({ error: 'Kun e-post fra nextron.no/.se/.dk/.fi (eller en godkjent adresse) kan booke.' });
  }
  // Datoregler
  const n = nights(b.checkIn, b.checkOut);
  if (n < config.MIN_NIGHTS || n > config.MAX_NIGHTS) {
    return res.status(400).json({ error: `Oppholdet må være mellom ${config.MIN_NIGHTS} og ${config.MAX_NIGHTS} netter.` });
  }
  if (b.checkIn < todayISO()) return res.status(400).json({ error: 'Innsjekk kan ikke være i fortiden.' });
  if (b.checkIn > maxDateISO()) return res.status(400).json({ error: 'Maks 18 måneder frem i tid.' });

  // Ledighet
  if (!(await rangeAvailable(b.checkIn, b.checkOut))) {
    return res.status(409).json({ error: 'Datoene er allerede opptatt.' });
  }

  const token = randomUUID();
  const verifyExpires = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  const { data: booking, error } = await supabase
    .from('bookings')
    .insert({
      check_in: b.checkIn, check_out: b.checkOut, name: b.name, email: b.email,
      guests: b.guests, message: b.message ?? null, lang: b.lang,
      status: 'pending', verify_token: token, verify_expires: verifyExpires,
    })
    .select('*').single();
  if (error || !booking) return res.status(500).json({ error: 'Kunne ikke opprette booking' });

  try {
    await sendVerificationEmail({ to: b.email, name: b.name, lang: b.lang, checkIn: b.checkIn, checkOut: b.checkOut, token });
  } catch (e) {
    console.error('Kunne ikke sende verifiserings-e-post:', e);
  }
  res.json({ ok: true, id: booking.id });
});

// ---------- Verifiser booking (lenke i e-post) ----------
app.get('/api/verify', async (req, res) => {
  const token = String(req.query.token ?? '');
  if (!token) return res.status(400).send(htmlPage('Ugyldig lenke', 'Lenken mangler en gyldig kode.'));

  const { data: booking } = await supabase
    .from('bookings').select('*').eq('verify_token', token).single();

  if (!booking) return res.status(404).send(htmlPage('Fant ikke bookingen', 'Lenken er ugyldig eller allerede brukt.'));
  if (booking.status === 'confirmed') {
    return res.send(htmlPage('Allerede bekreftet', 'Denne bookingen er allerede bekreftet. Sjekk e-posten din for detaljer.'));
  }
  if (booking.verify_expires && new Date(booking.verify_expires) < new Date()) {
    await supabase.from('bookings').update({ status: 'expired' }).eq('id', booking.id);
    return res.status(410).send(htmlPage('Lenken er utløpt', 'Bookingen ble ikke bekreftet i tide. Vennligst book på nytt.'));
  }
  // Dobbeltsjekk ledighet (i tilfelle noe ble booket i mellomtiden)
  if (!(await rangeAvailable(booking.check_in, booking.check_out, booking.id))) {
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', booking.id);
    return res.status(409).send(htmlPage('Datoene ble opptatt', 'Dessverre ble datoene booket av noen andre før du rakk å bekrefte.'));
  }

  await supabase.from('bookings')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), verify_token: null })
    .eq('id', booking.id);

  // Hent nøkkelboks-kode og send bekreftelse
  const { data: content } = await supabase.from('content').select('keybox_code,email_text').eq('id', 1).single();
  const extra = (content?.email_text && (content.email_text as any)[booking.lang]) || '';
  try {
    await sendConfirmedEmail({
      to: booking.email, name: booking.name, lang: booking.lang,
      checkIn: booking.check_in, checkOut: booking.check_out,
      keyboxCode: content?.keybox_code ?? '',
      extraText: extra,
    });
  } catch (e) { console.error('Kunne ikke sende bekreftelse:', e); }

  const en = booking.lang === 'en';
  res.send(htmlPage(
    en ? 'Booking confirmed!' : 'Booking bekreftet!',
    en ? 'Thank you! Your booking is confirmed and a confirmation email with access details has been sent.'
       : 'Takk! Bookingen din er bekreftet, og en e-post med adkomstinfo er sendt.'
  ));
});

// ---------- Admin: bookinger ----------
app.get('/api/admin/bookings', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const { data } = await supabase.from('bookings').select('*').order('check_in', { ascending: true });
  const list = (data ?? []).map((b: any) => ({
    id: b.id, checkIn: b.check_in, checkOut: b.check_out, name: b.name, email: b.email,
    guests: b.guests, message: b.message, status: b.status, source: 'booking', createdAt: b.created_at,
  }));
  // ta også med blokkerte (airbnb) så admin ser hele kalenderen
  const { data: bl } = await supabase.from('blocked_dates').select('*').order('start_date', { ascending: true });
  for (const d of bl ?? []) {
    list.push({ id: d.id, checkIn: d.start_date, checkOut: d.end_date, name: 'Airbnb', email: '', guests: 0, message: d.summary, status: 'confirmed', source: 'airbnb', createdAt: d.created_at });
  }
  list.sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  res.json(list);
});

app.delete('/api/admin/bookings/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const { error } = await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- Admin: opprett booking manuelt ----------
app.post('/api/admin/bookings', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const Body = z.object({
    checkIn: z.string().date(),
    checkOut: z.string().date(),
    name: z.string().min(2),
    email: z.string().email(),
    guests: z.number().int().min(1).max(6).default(2),
    message: z.string().max(1000).optional(),
    lang: z.enum(['no', 'en']).default('no'),
    confirmNow: z.boolean().default(true),   // bekreft direkte, eller send verifiseringslenke
    sendMail: z.boolean().default(false),    // send bekreftelsesmail med kode (kun ved confirmNow)
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ugyldige felt' });
  const b = parsed.data;

  // Admin kan booke for hvilken som helst e-post – ingen domenesjekk her.
  const n = nights(b.checkIn, b.checkOut);
  if (n < 1) return res.status(400).json({ error: 'Utsjekk må være etter innsjekk.' });
  if (!(await rangeAvailable(b.checkIn, b.checkOut))) {
    return res.status(409).json({ error: 'Datoene overlapper en eksisterende booking eller blokkering.' });
  }

  if (b.confirmNow) {
    const { data: booking, error } = await supabase.from('bookings').insert({
      check_in: b.checkIn, check_out: b.checkOut, name: b.name, email: b.email,
      guests: b.guests, message: b.message ?? 'Lagt inn av admin', lang: b.lang,
      status: 'confirmed', confirmed_at: new Date().toISOString(),
    }).select('id').single();
    if (error || !booking) return res.status(500).json({ error: 'Kunne ikke opprette booking' });

    if (b.sendMail) {
      const { data: content } = await supabase.from('content').select('keybox_code,email_text').eq('id', 1).maybeSingle();
      const extra = (content?.email_text && (content.email_text as any)[b.lang]) || '';
      try {
        await sendConfirmedEmail({ to: b.email, name: b.name, lang: b.lang, checkIn: b.checkIn, checkOut: b.checkOut, keyboxCode: content?.keybox_code ?? '', extraText: extra });
      } catch (e) { console.error('Bekreftelsesmail feilet:', e); }
    }
    return res.json({ ok: true, id: booking.id, status: 'confirmed' });
  } else {
    // Send verifiseringslenke som en vanlig booking
    const token = randomUUID();
    const verifyExpires = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const { data: booking, error } = await supabase.from('bookings').insert({
      check_in: b.checkIn, check_out: b.checkOut, name: b.name, email: b.email,
      guests: b.guests, message: b.message ?? 'Lagt inn av admin', lang: b.lang,
      status: 'pending', verify_token: token, verify_expires: verifyExpires,
    }).select('id').single();
    if (error || !booking) return res.status(500).json({ error: 'Kunne ikke opprette booking' });
    try {
      await sendVerificationEmail({ to: b.email, name: b.name, lang: b.lang, checkIn: b.checkIn, checkOut: b.checkOut, token });
    } catch (e) { console.error('Verifiseringsmail feilet:', e); }
    return res.json({ ok: true, id: booking.id, status: 'pending' });
  }
});

// ---------- Admin: rediger booking ----------
app.put('/api/admin/bookings/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const Body = z.object({
    checkIn: z.string().date().optional(),
    checkOut: z.string().date().optional(),
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    guests: z.number().int().min(1).max(6).optional(),
    message: z.string().max(1000).optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ugyldige felt' });
  const p = parsed.data;

  const { data: existing } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Fant ikke bookingen' });

  const newIn = p.checkIn ?? existing.check_in;
  const newOut = p.checkOut ?? existing.check_out;
  if (nights(newIn, newOut) < 1) return res.status(400).json({ error: 'Utsjekk må være etter innsjekk.' });
  // sjekk ledighet, men ignorer bookingen selv
  if (!(await rangeAvailable(newIn, newOut, existing.id))) {
    return res.status(409).json({ error: 'Nye datoer overlapper en annen booking/blokkering.' });
  }

  const patch: any = {};
  if (p.checkIn !== undefined) patch.check_in = p.checkIn;
  if (p.checkOut !== undefined) patch.check_out = p.checkOut;
  if (p.name !== undefined) patch.name = p.name;
  if (p.email !== undefined) patch.email = p.email;
  if (p.guests !== undefined) patch.guests = p.guests;
  if (p.message !== undefined) patch.message = p.message;
  const { error } = await supabase.from('bookings').update(patch).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- Admin: full innhold (inkl. kode + e-posttekst) ----------
app.get('/api/admin/content-full', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const { data } = await supabase.from('content').select('*').eq('id', 1).single();
  res.json({
    info: data?.info ?? null,
    airbnbIcalUrl: data?.airbnb_ical_url ?? '',
    keyboxCode: data?.keybox_code ?? '',
    emailText: data?.email_text ?? { no: '', en: '' },
  });
});

// ---------- Admin: innhold (CMS) ----------
app.put('/api/admin/content', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const Body = z.object({
    info: z.any().optional(),
    keyboxCode: z.string().max(40).optional(),
    emailText: z.object({ no: z.string().max(2000).optional(), en: z.string().max(2000).optional() }).optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ugyldige felt' });
  const patch: any = { id: 1, updated_at: new Date().toISOString() };
  if (parsed.data.info !== undefined) patch.info = parsed.data.info;
  if (parsed.data.keyboxCode !== undefined) patch.keybox_code = parsed.data.keyboxCode;
  if (parsed.data.emailText !== undefined) patch.email_text = parsed.data.emailText;
  const { error } = await supabase.from('content').upsert(patch, { onConflict: 'id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- Admin: Airbnb iCal ----------
app.put('/api/admin/airbnb', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const url = String(req.body?.airbnbIcalUrl ?? '').trim();
  const { error: upErr } = await supabase.from('content').upsert({ id: 1, airbnb_ical_url: url, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (upErr) return res.status(500).json({ error: 'Kunne ikke lagre URL: ' + upErr.message });
  try {
    const r = await syncAirbnb(url);
    if (r.collisions.length) { try { await sendCollisionAlert(r.collisions); } catch (e) { console.error('Kunne ikke sende kollisjonsvarsel:', e); } }
    res.json({ ok: true, imported: r.imported, collisions: r.collisions.length });
  } catch (e) {
    res.status(502).json({ error: 'Kunne ikke hente iCal: ' + (e instanceof Error ? e.message : '') });
  }
});

// Manuell trigger for synk (kan kalles av cron/Render scheduled job)
app.post('/api/admin/sync-airbnb', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });
  const { data } = await supabase.from('content').select('airbnb_ical_url').eq('id', 1).single();
  try {
    const r = await syncAirbnb(data?.airbnb_ical_url ?? '');
    if (r.collisions.length) { try { await sendCollisionAlert(r.collisions); } catch (e) { console.error('Kunne ikke sende kollisjonsvarsel:', e); } }
    res.json({ ok: true, imported: r.imported, collisions: r.collisions.length });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Feil' });
  }
});

// Diagnose: viser nøyaktig hva Render mottar fra Airbnb (kun admin)
app.get('/api/admin/airbnb-debug', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Ikke autorisert' });

  const out: any = {};

  // 1) Kan vi lese content-raden?
  const { data: row, error: readErr } = await supabase.from('content').select('*').eq('id', 1).maybeSingle();
  out.dbReadError = readErr ? readErr.message : null;
  out.contentRowExists = !!row;
  out.columnsPresent = row ? Object.keys(row) : [];
  const url = row?.airbnb_ical_url ?? '';
  out.urlSet = !!url;
  out.urlLength = url.length;
  out.urlTail = url ? url.slice(-24) : '';

  // 2) Test å skrive URL-en direkte og les tilbake umiddelbart
  const testUrl = 'https://TEST-WRITE.example/ical.ics';
  const { error: writeErr } = await supabase.from('content').upsert({ id: 1, airbnb_ical_url: testUrl }, { onConflict: 'id' });
  out.dbWriteError = writeErr ? writeErr.message : null;
  const { data: after } = await supabase.from('content').select('airbnb_ical_url').eq('id', 1).maybeSingle();
  out.urlAfterTestWrite = after?.airbnb_ical_url ?? '(tom)';
  out.testWritePersisted = (after?.airbnb_ical_url === testUrl);
  // sett tilbake KUN hvis det fantes en ekte url fra før (ikke overskriv en nylig lagret url med tom)
  if (url) {
    await supabase.from('content').upsert({ id: 1, airbnb_ical_url: url }, { onConflict: 'id' });
  }

  // 3) Hvis vi har en URL, prøv å hente den
  if (url) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SabiApartmentBooking/1.0; +https://www.sabi-apartment.no)',
          'Accept': 'text/calendar, text/plain, */*',
        },
        redirect: 'follow',
      });
      const text = await resp.text();
      out.httpStatus = resp.status;
      out.contentType = resp.headers.get('content-type');
      out.bodyLength = text.length;
      out.hasVCALENDAR = text.includes('BEGIN:VCALENDAR');
      out.veventCount = (text.match(/BEGIN:VEVENT/g) || []).length;
      out.bodyStart = text.slice(0, 200);
    } catch (e) {
      out.fetchError = e instanceof Error ? e.message : String(e);
    }
  }
  res.json(out);
});

// ---------- Enkel HTML-side for verifiseringssvar ----------
function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="no"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{font-family:Arial,sans-serif;background:#f7f6f2;color:#16213e;display:grid;place-items:center;min-height:100vh;margin:0}
  .c{background:#fff;border:1px solid #e0ddd3;border-radius:16px;padding:38px 34px;max-width:440px;text-align:center;box-shadow:0 10px 40px rgba(27,42,94,.1)}
  h1{color:#1b2a5e;font-size:24px;margin:0 0 12px}p{color:#41506b;line-height:1.5}a{color:#2f9fd8}
  .b{display:inline-block;margin-top:18px;background:#1b2a5e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px}</style>
  </head><body><div class="c"><h1>${title}</h1><p>${body}</p>
  <a class="b" href="${config.PUBLIC_URL}">Til bookingsiden</a></div></body></html>`;
}

// ---------- Statiske filer ----------
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(config.PORT, () => {
  console.log(`Sabi Apartment kjører på ${config.PUBLIC_URL} (port ${config.PORT})`);
});
