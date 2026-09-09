const required = [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'COUNTRIES_API_URL',
  'COUNTRIES_API_KEY',
  'CHECKOUT_SUCCESS_URL',
  'CHECKOUT_CANCEL_URL',
] as const;

const missing = required.filter((k) => !process.env[k]);
if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);

export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  DATABASE_URL: process.env.DATABASE_URL!,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
  COUNTRIES_API_URL: process.env.COUNTRIES_API_URL!.replace(/\/+$/, ''),
  COUNTRIES_API_KEY: process.env.COUNTRIES_API_KEY!,
  CHECKOUT_SUCCESS_URL: process.env.CHECKOUT_SUCCESS_URL!,
  CHECKOUT_CANCEL_URL: process.env.CHECKOUT_CANCEL_URL!,
};
