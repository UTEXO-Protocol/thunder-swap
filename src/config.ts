import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

const configSchema = z.object({
  BITCOIN_RPC_URL: z.string().url(),
  BITCOIN_RPC_USER: z.string(),
  BITCOIN_RPC_PASS: z.string(),
  NETWORK: z.enum(['regtest', 'signet', 'testnet', 'mainnet']),
  MIN_CONFS: z.string().transform((val) => parseInt(val, 10)),
  LOCKTIME_BLOCKS: z.string().transform((val) => parseInt(val, 10)),
  LP_ACCOUNT_XPRV: z.string().min(1),
  LP_WIF: z.string().min(1),
  LP_PUBKEY_HEX: z
    .string()
    .regex(/^(02|03)[0-9a-fA-F]{64}$/, 'LP_PUBKEY_HEX must be a compressed pubkey'),
  LP_CLAIM_ADDRESS: z.string().min(1),
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
  NETWORK: process.env.NETWORK!,
  MIN_CONFS: process.env.MIN_CONFS!,
  LOCKTIME_BLOCKS: process.env.LOCKTIME_BLOCKS!,
  LP_ACCOUNT_XPRV: process.env.LP_ACCOUNT_XPRV!,
  LP_WIF: process.env.LP_WIF!,
  LP_PUBKEY_HEX: process.env.LP_PUBKEY_HEX,
  LP_CLAIM_ADDRESS: process.env.LP_CLAIM_ADDRESS!,
  RLN_BASE_URL: process.env.RLN_BASE_URL!,
  RLN_API_KEY: process.env.RLN_API_KEY,
  HODL_EXPIRY_SEC: process.env.HODL_EXPIRY_SEC ?? '86400'
});

export type Config = z.infer<typeof configSchema>;
