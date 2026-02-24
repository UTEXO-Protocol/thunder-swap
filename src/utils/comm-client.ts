import axios from 'axios';
import { config } from '../config.js';
import type { RgbInvoiceHtlcResponse } from '../rln/types.js';

export interface SubmarineRequest {
  invoice: string;
  userRefundPubkeyHex: string;
  // paymentHash is NOT included - LP decodes invoice & extracts it
}

export interface FundingData {
  fundingTxid: string;
  fundingVout: number;
}

const USER_COMM_URL = config.USER_COMM_URL ?? 'http://localhost:9999';

export async function fetchSubmarineRequest(): Promise<SubmarineRequest> {
  const response = await axios.get<SubmarineRequest | { error: string }>(
    `${USER_COMM_URL}/submarine`
  );
  const data = response.data as any;
  if (data?.error) {
    throw new Error(data.error);
  }
  return data as SubmarineRequest;
}

export async function waitForSubmarineRequest(
  maxAttempts: number = 1800, // 1800 attempts × 2s = 3600s = 1 hour
  pollIntervalMs: number = 2000
): Promise<SubmarineRequest> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const data = await fetchSubmarineRequest();
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
  throw new Error('Failed to retrieve submarine request.');
}

export async function sendRgbInvoiceHtlcResponse(
  payload: RgbInvoiceHtlcResponse
): Promise<void> {
  await axios.post(`${USER_COMM_URL}/rgbinvoicehtlc`, payload, {
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function fetchFundingData(): Promise<FundingData> {
  const response = await axios.get<FundingData | { error: string }>(`${USER_COMM_URL}/funding`);
  const data = response.data as any;
  if (data?.error) {
    throw new Error(data.error);
  }
  return data as FundingData;
}

export async function waitForFundingData(
  maxAttempts: number = 1800,
  pollIntervalMs: number = 2000
): Promise<FundingData> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const data = await fetchFundingData();
      return data;
    } catch (err) {
      if (i < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Failed to retrieve funding data.');
}
