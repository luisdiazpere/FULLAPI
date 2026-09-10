import nodemailer from 'nodemailer';
import { render } from './format.ts';
import { env } from './env.ts';

/** The whole Brevo contract lives in this file, same as src/shipping.ts does for Shippo. */
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export function emailConfigured(): boolean {
  return Boolean(process.env.BREVO_SMTP_USER && process.env.BREVO_SMTP_PASS && process.env.EMAIL_FROM);
}

function transport() {
  transporter ??= nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST ?? 'smtp-relay.brevo.com',
    port: Number(process.env.BREVO_SMTP_PORT ?? 587),
    auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASS },
  });
  return transporter;
}

async function send(to: string, subject: string, text: string, html?: string): Promise<void> {
  if (!emailConfigured()) {
    console.error('[email] BREVO_SMTP_USER/PASS or EMAIL_FROM not set, skipping', { to, subject });
    return;
  }
  await transport().sendMail({ from: process.env.EMAIL_FROM, to, subject, text, html });
}

const money = (amountMinor: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountMinor / 100);

const PAYMENT_TEMPLATE =
  'Hi! Your payment of {amount} {currency} for order {sessionId} has been confirmed. '
  + 'We are getting it ready to ship.';

/**
 * Table-based, inline-styled HTML: the layout that survives Outlook's Word
 * rendering engine and clients that strip <style> blocks. The circular seal
 * badge and diagonal stripe degrade to a square badge and a plain rule there —
 * everything a buyer actually needs to read stays plain text regardless.
 */
function paymentConfirmationHtml(order: {
  sessionId: string;
  amountTotal: number | null;
  currency: string | null;
  items: { name: string | null; quantity: number | null; amountTotal: number | null }[];
}): string {
  const currency = order.currency ?? 'usd';
  const orderUrl = env.CHECKOUT_SUCCESS_URL.replace('{CHECKOUT_SESSION_ID}', order.sessionId);
  const total = order.amountTotal != null ? money(order.amountTotal, currency) : '—';

  const rows = order.items
    .map((item) => {
      const label = `${item.name ?? 'Kit'}${item.quantity && item.quantity > 1 ? ` ×${item.quantity}` : ''}`;
      const amount = item.amountTotal != null ? money(item.amountTotal, currency) : '';
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #DED2B4;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#2A2620;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #DED2B4;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#2A2620;text-align:right;white-space:nowrap;">${amount}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Order confirmed</title>
<style>
  @media (max-width: 480px) {
    .card { width: 100% !important; }
    .pad { padding-left: 22px !important; padding-right: 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#E7DECB;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Your payment cleared and the order is being packed for its trip.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#E7DECB;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0"
               style="width:600px;max-width:600px;background-color:#FBF8F1;border:1px solid #DED2B4;">
          <tr>
            <td style="height:8px;line-height:8px;font-size:0;background:repeating-linear-gradient(45deg,#9E2B25 0 10px,#FBF8F1 10px 20px,#1F3A5F 20px 30px,#FBF8F1 30px 40px);">&nbsp;</td>
          </tr>
          <tr>
            <td class="pad" align="center" style="padding:36px 40px 8px;">
              <span style="font-family:Georgia,'Times New Roman',serif;font-size:14px;letter-spacing:0.5px;color:#1F3A5F;">Bandera y Sello</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 0 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="84" height="84" align="center" valign="middle"
                      style="width:84px;height:84px;border-radius:50%;background-color:#9E2B25;border:3px double #E4C9B0;">
                    <span style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:bold;letter-spacing:2px;color:#FBF8F1;">PAID</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="pad" align="center" style="padding:0 40px;">
              <h1 style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;font-weight:bold;color:#2A2620;">Your order is confirmed</h1>
              <p style="margin:0 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.5;color:#4A4438;">We're getting it ready to ship.</p>
            </td>
          </tr>
          <tr>
            <td class="pad" style="padding:0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${rows}
                <tr>
                  <td style="padding:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:bold;color:#2A2620;">Total</td>
                  <td style="padding:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:bold;color:#2A2620;text-align:right;">${total}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:32px 40px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#9E2B25;">
                    <a href="${orderUrl}" style="display:inline-block;padding:13px 28px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#FBF8F1;text-decoration:none;">View your order</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="pad" align="center" style="padding:24px 40px 36px;">
              <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:12px;color:#A98F63;">Order ${order.sessionId}</p>
              <p style="margin:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#8A8272;">Bandera y Sello. Reply to this email with any questions.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const WELCOME_TEXT =
  "You're in. Flags, wax seals, capital postcards, and currency coin frames from real countries — "
  + 'pick one and we\'ll get it in the mail.';

/** Same card shell as paymentConfirmationHtml, minus the order-specific rows. */
function welcomeHtml(): string {
  const shopUrl = (process.env.SHOP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Welcome to Bandera y Sello</title>
<style>
  @media (max-width: 480px) {
    .card { width: 100% !important; }
    .pad { padding-left: 22px !important; padding-right: 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#E7DECB;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Your account's ready. Now go pick a country.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#E7DECB;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0"
               style="width:600px;max-width:600px;background-color:#FBF8F1;border:1px solid #DED2B4;">
          <tr>
            <td style="height:8px;line-height:8px;font-size:0;background:repeating-linear-gradient(45deg,#9E2B25 0 10px,#FBF8F1 10px 20px,#1F3A5F 20px 30px,#FBF8F1 30px 40px);">&nbsp;</td>
          </tr>
          <tr>
            <td class="pad" align="center" style="padding:36px 40px 8px;">
              <span style="font-family:Georgia,'Times New Roman',serif;font-size:14px;letter-spacing:0.5px;color:#1F3A5F;">Bandera y Sello</span>
            </td>
          </tr>
          <tr>
            <td class="pad" align="center" style="padding:28px 40px 0;">
              <h1 style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;font-weight:bold;color:#2A2620;">You're in</h1>
              <p style="margin:0 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.5;color:#4A4438;">Flags, wax seals, capital postcards, and currency coin frames from real countries — pick one and we'll get it in the mail.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 40px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#9E2B25;">
                    <a href="${shopUrl}" style="display:inline-block;padding:13px 28px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#FBF8F1;text-decoration:none;">Browse the shop</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="pad" align="center" style="padding:32px 40px 36px;">
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#8A8272;">Bandera y Sello. Reply to this email with any questions.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const SHIPPING_TEMPLATES: Record<string, { subject: string; body: string }> = {
  in_transit: { subject: 'Your order has shipped', body: 'Your order {sessionId} has shipped{tracking}.' },
  delivered: { subject: 'Your order was delivered', body: 'Your order {sessionId} was delivered{tracking}.' },
  failed: {
    subject: 'Delivery problem with your order',
    body: 'There was a problem delivering your order {sessionId}{tracking}. We are looking into it.',
  },
  returned: {
    subject: 'Your order is being returned',
    body: 'Your order {sessionId} is being returned to us{tracking}.',
  },
};

export async function sendPaymentConfirmation(
  to: string,
  order: {
    sessionId: string;
    amountTotal: number | null;
    currency: string | null;
    items?: { name: string | null; quantity: number | null; amountTotal: number | null }[];
  },
): Promise<void> {
  const amount = order.amountTotal != null ? (order.amountTotal / 100).toFixed(2) : 'unknown';
  const { text } = render(PAYMENT_TEMPLATE, {
    amount, currency: order.currency?.toUpperCase(), sessionId: order.sessionId,
  });
  const html = paymentConfirmationHtml({ ...order, items: order.items ?? [] });
  await send(to, 'Your order is confirmed', text, html);
}

export async function sendWelcomeEmail(to: string): Promise<void> {
  await send(to, 'Welcome to Bandera y Sello', WELCOME_TEXT, welcomeHtml());
}

export async function sendShippingStatusEmail(
  to: string,
  order: { sessionId: string; trackingNumber: string | null },
  status: string,
): Promise<void> {
  const template = SHIPPING_TEMPLATES[status];
  if (!template) return;
  const tracking = order.trackingNumber ? ` (tracking: ${order.trackingNumber})` : '';
  const { text } = render(template.body, { sessionId: order.sessionId, tracking });
  await send(to, template.subject, text);
}
