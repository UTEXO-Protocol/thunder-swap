import axios from 'axios';
import { config } from '../config.js';

export interface SubmarineData {
  invoice: string;
  fundingTxid: string;
  fundingVout: number;
  userRefundPubkeyHex: string;
  tLock: number; // Timelock block height used by USER when building HTLC
  // paymentHash is NOT included - LP decodes invoice & extracts it
}

const USER_COMM_URL = config.USER_COMM_URL ?? 'http://localhost:9999';

export async function fetchSubmarineData(): Promise<SubmarineData> {
  const response = await axios.get<SubmarineData | { error: string }>(`${USER_COMM_URL}/submarine`);
  const data = response.data as any;
  if (data?.error) {
    throw new Error(data.error);
  }
  return data as SubmarineData;
}

export async function waitForSubmarineData(
  maxAttempts: number = 1800, // 1800 attempts × 2s = 3600s = 1 hour
  pollIntervalMs: number = 2000
): Promise<SubmarineData> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const data = await fetchSubmarineData();
      return data;
    } catch (err) {
      if (i < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      } else {
        throw err;
      }
    }
  }
  // should never reach here
  throw new Error('Failed to retrieve submarine data.');
}
