import axios from 'axios';
import { parse } from 'dotenv';
import { readFileSync } from 'fs';

function getPaymentHashArg(): string {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error('Usage: npm run scan -- <payment_hash>');
  }
  const paymentHash = args[0].trim();
  if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) {
    throw new Error('payment_hash must be 32-byte hex');
  }
  return paymentHash;
}

async function main() {
  try {
    const payment_hash = getPaymentHashArg();
    const lpEnv = parse(readFileSync('.env.lp'));
    const baseUrl = lpEnv.RLN_BASE_URL_L1 ?? lpEnv.RLN_BASE_URL;
    if (!baseUrl) {
      throw new Error('LP L1 base URL not configured. Set RLN_BASE_URL_L1 in .env.lp');
    }
    const apiKey = lpEnv.RLN_API_KEY_L1 ?? lpEnv.RLN_API_KEY;
    const httpClient = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && {
          Authorization: `Bearer ${apiKey}`
        })
      }
    });
    const response = await httpClient.post('/htlcscan', { payment_hash });
    const result = response.data;
    console.log(
      JSON.stringify(
        {
          payment_hash,
          result
        },
        null,
        2
      )
    );
  } catch (error: any) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

void main();
