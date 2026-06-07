// Engangs-script: legger inn bookinger fra det gamle systemet som BEKREFTEDE
// bookinger i det nye systemet, og sender bekreftelses-e-post (med nøkkelboks-kode)
// til hver gjest – som om de hadde booket i det nye systemet.
//
// Kjøres lokalt eller som en Render "Job"/Shell:
//   - må ha samme miljøvariabler som web-tjenesten (SUPABASE_*, SMTP_*, MAIL_FROM osv.)
//   - bygg først:  npm install && npm run build
//   - kjør:        node dist/migrate-old-bookings.js
//
// Scriptet er idempotent på datoer: hvis en bekreftet booking med nøyaktig samme
// e-post + innsjekk + utsjekk allerede finnes, hoppes den over (så du kan kjøre på nytt
// uten å lage duplikater eller sende mail to ganger).

import { supabase } from './supabase.js';
import { sendConfirmedEmail } from './mailer.js';

// ---- Bookingene som skal migreres ----
// checkOut er utsjekk-dato (eksklusiv), slik resten av systemet bruker.
const OLD_BOOKINGS = [
  {
    name: 'Mikael Karlsson',
    email: 'mikael@nextron.no',
    checkIn: '2026-06-05',
    checkOut: '2026-06-16',
    guests: 2,
    lang: 'no' as const,
  },
  {
    name: 'Jan Mikal Sand',
    email: 'jan@nextron.no',
    checkIn: '2026-08-16',
    checkOut: '2026-08-30',
    guests: 4,
    lang: 'no' as const,
  },
];

async function main() {
  // Hent nøkkelboks-kode + ev. ekstra e-posttekst til bekreftelsesmailen
  const { data: content } = await supabase
    .from('content')
    .select('keybox_code,email_text')
    .eq('id', 1)
    .maybeSingle();
  const keybox = content?.keybox_code ?? '';

  for (const b of OLD_BOOKINGS) {
    // Finnes den allerede? (samme e-post + datoer, bekreftet)
    const { data: existing } = await supabase
      .from('bookings')
      .select('id')
      .eq('email', b.email)
      .eq('check_in', b.checkIn)
      .eq('check_out', b.checkOut)
      .eq('status', 'confirmed');

    if (existing && existing.length) {
      console.log(`⏭  Hopper over ${b.name} (${b.checkIn}→${b.checkOut}) – finnes allerede.`);
      continue;
    }

    // Legg inn som bekreftet booking
    const { data: inserted, error } = await supabase
      .from('bookings')
      .insert({
        check_in: b.checkIn,
        check_out: b.checkOut,
        name: b.name,
        email: b.email,
        guests: b.guests,
        message: 'Migrert fra gammelt system',
        lang: b.lang,
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !inserted) {
      console.error(`❌  Klarte ikke å legge inn ${b.name}:`, error?.message);
      continue;
    }
    console.log(`✅  La inn ${b.name} (${b.checkIn}→${b.checkOut}), id=${inserted.id}`);

    // Send bekreftelsesmail med kode
    const extra = (content?.email_text && (content.email_text as any)[b.lang]) || '';
    try {
      await sendConfirmedEmail({
        to: b.email,
        name: b.name,
        lang: b.lang,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        keyboxCode: keybox,
        extraText: extra,
      });
      console.log(`   ✉️  Bekreftelsesmail sendt til ${b.email}`);
    } catch (e) {
      console.error(`   ⚠️  Booking lagret, men mail feilet for ${b.email}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log('Ferdig.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Uventet feil:', e);
  process.exit(1);
});
