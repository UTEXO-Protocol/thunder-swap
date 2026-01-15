import axios, { AxiosError } from 'axios';
import { config } from '../config.js';

export interface SubmarineData {
  invoice: string;
  fundingTxid: string;
  fundingVout: number;
  userRefundPubkeyHex: string;
  paymentHash: string;
  tLock: number; // Timelock block height used by USER when building HTLC
}

const USER_COMM_URL = config.USER_COMM_URL ?? 'http://localhost:9999';
const REQUEST_TIMEOUT_MS = 1500;
const MAX_BACKOFF_MS = 10000;

function assertSubmarineData(data: any): asserts data is SubmarineData {
  if (
    !data ||
    typeof data.invoice !== 'string' ||
    typeof data.fundingTxid !== 'string' ||
    typeof data.fundingVout !== 'number' ||
    typeof data.userRefundPubkeyHex !== 'string' ||
    typeof data.paymentHash !== 'string'
  ) {
    throw new Error('Invalid submarine payload received.');
  }
}

export async function fetchSubmarineData(): Promise<SubmarineData | null> {
  const response = await axios.get<SubmarineData>(`${USER_COMM_URL}/submarine`, {
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: (status) => status === 200 || status === 204
  });

  if (response.status === 204) {
    return null;
  }

  const data = response.data as any;
  assertSubmarineData(data);
  return data;
}

export async function waitForSubmarineData(
  maxAttempts: number = 60,
  pollIntervalMs: number = 2000
): Promise<SubmarineData> {
  let delayMs = pollIntervalMs;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const data = await fetchSubmarineData();
      if (data) {
        return data;
      }
    } catch (err) {
      const axiosErr = err as AxiosError;
      // If the server is unreachable or times out, keep retrying within bounds.
      if (
        axiosErr?.code !== 'ECONNABORTED' &&
        axiosErr?.code !== 'ECONNREFUSED' &&
        axiosErr?.code !== 'ECONNRESET'
      ) {
        if (i >= maxAttempts - 1) {
          throw err;
        }
      }
    }

    if (i >= maxAttempts - 1) {
      break;
    }

    const jitter = Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, delayMs + jitter));
    // Gradual backoff (without changing the base poll setting) to reduce hammering.
    delayMs = Math.min(Math.floor(delayMs * 1.2), MAX_BACKOFF_MS);
  }

  throw new Error(`Failed to retrieve submarine data after ${maxAttempts} attempts.`);
}
