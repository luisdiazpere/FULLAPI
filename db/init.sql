CREATE TABLE kits (
  sku                  text PRIMARY KEY CHECK (sku ~ '^[a-z0-9-]{1,64}$'),
  name_template        text NOT NULL,
  description_template text NOT NULL,
  unit_amount          integer NOT NULL CHECK (unit_amount > 0),
  currency             char(3) NOT NULL,
  stock                integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active               boolean NOT NULL DEFAULT true,
  -- Carrier rates need a parcel. Dimensions are per single kit; an order's box is
  -- derived by stacking them (see src/parcel.ts).
  weight_grams         integer NOT NULL CHECK (weight_grams > 0),
  length_cm            integer NOT NULL CHECK (length_cm > 0),
  width_cm             integer NOT NULL CHECK (width_cm > 0),
  height_cm            integer NOT NULL CHECK (height_cm > 0)
);

-- Templates render against the REST Countries payload: {country} {capital} {currency} {code}
INSERT INTO kits (sku, name_template, description_template, unit_amount, currency, stock,
                  weight_grams, length_cm, width_cm, height_cm) VALUES
  ('flag-and-seal',
   'Flag & Seal Kit - {country}',
   'Woven flag of {country}, wax seal stamp and a capital-city postcard from {capital}.',
   2900, 'usd', 40, 600, 25, 20, 6),
  ('capital-postcards',
   'Capital Postcard Set - {capital}, {country}',
   'Twelve letterpress postcards of {capital}, boxed with the {country} flag sticker sheet.',
   1800, 'usd', 75, 300, 18, 13, 3),
  ('currency-coin-frame',
   'Currency Frame - {currency}',
   'Shadow box holding a circulated {currency} coin beside the flag of {country}.',
   4500, 'usd', 12, 900, 26, 21, 5),
  ('collector-bundle',
   'Collector Bundle - {country} ({code})',
   'All three kits for {country}: flag, postcards from {capital}, and a {currency} coin frame.',
   7900, 'usd', 0, 1700, 30, 24, 12);
