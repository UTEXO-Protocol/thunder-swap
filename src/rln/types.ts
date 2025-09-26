/**
 * Response from decode invoice API call
 */
export interface DecodeInvoiceResponse {
  payment_hash: string;
  amount_sat: number;
  expires_at?: number;
}

/**
 * Response from pay invoice API call
 */
export interface PayInvoiceResponse {
  status: 'succeeded' | 'failed';
  preimage?: string;
  error?: string;
}

/**
 * Base RGB-LN API client interface
 */
export interface RLNClientInterface {
  decode(invoice: string): Promise<DecodeInvoiceResponse>;
  pay(invoice: string): Promise<PayInvoiceResponse>;
}
