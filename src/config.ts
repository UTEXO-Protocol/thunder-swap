import dotenv from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'node:fs';

// Load shared defaults first (.env), then overlay role-specific config (.env.lp / .env.user).
if (existsSync('.env')) {
  dotenv.config({ path: '.env' });
}

const clientRole = process.env.CLIENT_ROLE?.toUpperCase();
if (!clientRole) {
  throw new Error(
    'CLIENT_ROLE environment variable is required. Set it to LP or USER (put CLIENT_ROLE in .env).'
  );
}
if (clientRole !== 'LP' && clientRole !== 'USER') {
  throw new Error('CLIENT_ROLE must be either LP or USER');
}

const envFile = `.env.${clientRole.toLowerCase()}`;
if (existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

export const CLIENT_ROLE = clientRole;

const numberFromString = z.preprocess(
  (value) => (typeof value === 'string' ? Number(value) : value),
  z.number().positive()
);

const configSchema = z.object({
  BITCOIN_RPC_URL: z.string().url(),
  BITCOIN_RPC_USER: z.string(),
  BITCOIN_RPC_PASS: z.string(),
  WIF: z.string().min(1),
  NETWORK: z.enum(['regtest', 'signet', 'testnet', 'mainnet']),
  MIN_CONFS: z.string().transform((val) => parseInt(val, 10)),
  LOCKTIME_BLOCKS: z.string().transform((val) => parseInt(val, 10)),
  FEE_RATE_SAT_PER_VB: numberFromString,
  LP_PUBKEY_HEX: z
    .string()
    .regex(/^(02|03)[0-9a-fA-F]{64}$/, 'LP_PUBKEY_HEX must be a compressed pubkey'),
  RLN_BASE_URL: z.string().url(),
  RLN_API_KEY: z.string().optional(),
  HODL_EXPIRY_SEC: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default('86400')
});

export const config = configSchema.parse({
  BITCOIN_RPC_URL: process.env.BITCOIN_RPC_URL!,
  BITCOIN_RPC_USER: process.env.BITCOIN_RPC_USER!,
  BITCOIN_RPC_PASS: process.env.BITCOIN_RPC_PASS!,
  WIF: process.env.WIF!,
  NETWORK: process.env.NETWORK!,
  MIN_CONFS: process.env.MIN_CONFS!,
  LOCKTIME_BLOCKS: process.env.LOCKTIME_BLOCKS!,
  FEE_RATE_SAT_PER_VB: process.env.FEE_RATE_SAT_PER_VB ?? '1',
  LP_PUBKEY_HEX: process.env.LP_PUBKEY_HEX,
  RLN_BASE_URL: process.env.RLN_BASE_URL!,
  RLN_API_KEY: process.env.RLN_API_KEY,
  HODL_EXPIRY_SEC: process.env.HODL_EXPIRY_SEC ?? '86400'
});

export type Config = z.infer<typeof configSchema>;
