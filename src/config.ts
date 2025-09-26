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
  LP_WIF: z.string().min(1),
  LP_CLAIM_ADDRESS: z.string().min(1),
  RLN_BASE_URL: z.string().url(),
  RLN_API_KEY: z.string().optional(),
});

export const config = configSchema.parse({
  BITCOIN_RPC_URL: process.env.BITCOIN_RPC_URL!,
  BITCOIN_RPC_USER: process.env.BITCOIN_RPC_USER!,
  BITCOIN_RPC_PASS: process.env.BITCOIN_RPC_PASS!,
  NETWORK: process.env.NETWORK!,
  MIN_CONFS: process.env.MIN_CONFS!,
  LOCKTIME_BLOCKS: process.env.LOCKTIME_BLOCKS!,
  LP_WIF: process.env.LP_WIF!,
  LP_CLAIM_ADDRESS: process.env.LP_CLAIM_ADDRESS!,
  RLN_BASE_URL: process.env.RLN_BASE_URL!,
  RLN_API_KEY: process.env.RLN_API_KEY,
});

export type Config = z.infer<typeof configSchema>;
