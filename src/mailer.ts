import nodemailer from 'nodemailer';
import { config } from './config.js';

function smtpReady() {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS && config.MAIL_FROM);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const transporter = smtpReady()
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    })
  : null;

type Texts = { subject: string; heading: string; body: string; cta: string };

function verifyTexts(lang: string, name: string, checkIn: string, checkOut: string): Texts {
  if (lang === 'en') {
    return {
      subject: 'Confirm your Duquesa apartment booking',
      heading: `Hi ${name},`,
      body: `Please confirm your booking of the Nextron Duquesa apartment from <b>${checkIn}</b> to <b>${checkOut}</b>. Your booking is not valid until you confirm by clicking the button below. The link expires in 48 hours.`,
      cta: 'Confirm booking',
    };
  }
  return {
    subject: 'Bekreft din booking av Duquesa-leiligheten',
    heading: `Hei ${name},`,
    body: `Bekreft din booking av Nextrons Duquesa-leilighet fra <b>${checkIn}</b> til <b>${checkOut}</b>. Bookingen er ikke gyldig før du bekrefter ved å trykke på knappen under. Lenken utløper om 48 timer.`,
    cta: 'Bekreft booking',
  };
}

function shell(inner: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#16213e">
    <div style="background:#1b2a5e;color:#fff;padding:20px 24px;border-radius:14px 14px 0 0">
      <span style="font-size:20px;font-weight:700">Nextron Duquesa Apartment</span>
    </div>
    <div style="border:1px solid #e0ddd3;border-top:none;border-radius:0 0 14px 14px;padding:24px">
      ${inner}
    </div>
  </div>`;
}

export async function sendVerificationEmail(opts: {
  to: string; name: string; lang: string; checkIn: string; checkOut: string; token: string;
}) {
  if (!transporter || !config.MAIL_FROM) {
    console.warn('SMTP ikke konfigurert – hopper over verifiserings-e-post.');
    return;
  }
  const t = verifyTexts(opts.lang, opts.name, opts.checkIn, opts.checkOut);
  const link = `${config.PUBLIC_URL}/api/verify?token=${encodeURIComponent(opts.token)}`;
  const html = shell(`
    <p>${t.heading}</p>
    <p>${t.body}</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${link}" style="background:#1b2a5e;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block">${t.cta}</a>
    </p>
    <p style="font-size:12px;color:#6b7280">${link}</p>
  `);
  await transporter.sendMail({ from: config.MAIL_FROM, to: opts.to, subject: t.subject, html });
}

export async function sendAccessEmail(opts: { to: string; lang: string; token: string }) {
  if (!transporter || !config.MAIL_FROM) {
    console.warn('SMTP ikke konfigurert – hopper over tilgangslenke.');
    return;
  }
  const en = opts.lang === 'en';
  const link = `${config.PUBLIC_URL}/api/access/verify?token=${encodeURIComponent(opts.token)}`;
  const subject = en ? 'Your access link – Nextron Duquesa' : 'Din tilgangslenke – Nextron Duquesa';
  const cta = en ? 'Open the booking site' : 'Åpne bookingsiden';
  const body = en
    ? 'Click the button below to access the Nextron Duquesa booking site. The link is valid for 24 hours, and your access lasts for 30 days on this device.'
    : 'Trykk på knappen under for å få tilgang til Nextron Duquesa bookingside. Lenken er gyldig i 24 timer, og tilgangen varer i 30 dager på denne enheten.';
  const html = shell(`
    <p>${en ? 'Hi,' : 'Hei,'}</p>
    <p>${body}</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${link}" style="background:#1b2a5e;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:600;display:inline-block">${cta}</a>
    </p>
    <p style="font-size:12px;color:#6b7280">${link}</p>
  `);
  await transporter.sendMail({ from: config.MAIL_FROM, to: opts.to, subject, html });
}

export async function sendConfirmedEmail(opts: {
  to: string; name: string; lang: string; checkIn: string; checkOut: string; keyboxCode: string; extraText?: string;
}) {
  if (!transporter || !config.MAIL_FROM) return;
  const en = opts.lang === 'en';
  const subject = en ? 'Booking confirmed – Duquesa apartment' : 'Booking bekreftet – Duquesa-leiligheten';
  const codeBlock = opts.keyboxCode
    ? (en
        ? `<p>The key box (marked “Quad AS”, by the church in Sabinillas) code is:</p>
           <p style="font-size:26px;font-weight:700;letter-spacing:3px;color:#1b2a5e;text-align:center;margin:14px 0">${opts.keyboxCode}</p>`
        : `<p>Koden til nøkkelboksen (merket «Quad AS», ved kirken i Sabinillas) er:</p>
           <p style="font-size:26px;font-weight:700;letter-spacing:3px;color:#1b2a5e;text-align:center;margin:14px 0">${opts.keyboxCode}</p>`)
    : '';
  const extraBlock = opts.extraText && opts.extraText.trim()
    ? `<div style="margin:14px 0;white-space:pre-line">${escapeHtml(opts.extraText.trim())}</div>`
    : '';
  const html = shell(en ? `
    <p>Hi ${opts.name},</p>
    <p>Your booking is now <b>confirmed</b>: <b>${opts.checkIn}</b> to <b>${opts.checkOut}</b>.</p>
    ${codeBlock}
    ${extraBlock}
    <p>Have a great stay!</p>
    <p style="color:#6b7280;font-size:13px">For urgent local matters: Wilkins Property Management, +34 951 277 170.</p>
  ` : `
    <p>Hei ${opts.name},</p>
    <p>Bookingen din er nå <b>bekreftet</b>: <b>${opts.checkIn}</b> til <b>${opts.checkOut}</b>.</p>
    ${codeBlock}
    ${extraBlock}
    <p>God tur!</p>
    <p style="color:#6b7280;font-size:13px">Ved akutte lokale behov: Wilkins Property Management, +34 951 277 170.</p>
  `);
  await transporter.sendMail({ from: config.MAIL_FROM, to: opts.to, subject, html });

  if (config.MAIL_ADMIN) {
    await transporter.sendMail({
      from: config.MAIL_FROM, to: config.MAIL_ADMIN,
      subject: `Ny bekreftet booking: ${opts.checkIn} → ${opts.checkOut}`,
      text: `${opts.name} (${opts.to}) har bekreftet booking ${opts.checkIn} til ${opts.checkOut}.`,
    });
  }
}
