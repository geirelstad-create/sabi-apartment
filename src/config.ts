import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.warn(`ADVARSEL: miljøvariabel ${name} mangler.`);
    return '';
  }
  return v;
}

export const config = {
  PORT: Number(process.env.PORT ?? 4000),
  // Den offentlige URL-en til appen (brukes i verifiseringslenker og e-post)
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:4000',

  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),

  // SMTP for e-post
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,        // f.eks. "Nextron Duquesa <booking@sabi-apartment.no>"
  MAIL_ADMIN: process.env.MAIL_ADMIN,      // valgfri: varsel til admin ved ny booking

  // Admin
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,

  // Hemmelig nøkkel for å signere adgangsbilletter (porten). Sett en lang tilfeldig verdi.
  ACCESS_SECRET: process.env.ACCESS_SECRET ?? process.env.ADMIN_PASSWORD ?? 'endre-meg',
  ACCESS_TICKET_DAYS: 30,

  // Anthropic API-nøkkel for maskinoversettelse (valgfri – knappen virker kun hvis satt)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // Booking-regler
  MIN_NIGHTS: 4,
  MAX_NIGHTS: 14,
  MAX_MONTHS_AHEAD: 18,
  ALLOWED_DOMAINS: ['nextron.no', 'nextron.se', 'nextron.dk', 'nextron.fi'],
};
