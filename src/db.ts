import pg from 'pg';
import { env } from './env.ts';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });

export type Kit = {
  sku: string;
  name_template: string;
  description_template: string;
  unit_amount: number;
  currency: string;
  stock: number;
  active: boolean;
  weight_grams: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
};
