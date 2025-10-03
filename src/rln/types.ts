/**
 * Response from decode invoice API call
 */
export interface DecodeInvoiceResponse {
  payment_hash: string;
  amt_msat: number;
  expires_at?: number;
}

/**
 * Response from pay invoice API call
 */
export interface PayInvoiceResponse {
  status: 'Succeeded' | 'Failed'|'Pending';
  payment_hash: string;
  payment_secret: string;
}

/**
 * Payment details from getPayment API call
 */
export interface PaymentDetails {
  amt_msat: number;
  asset_amount: number;
  asset_id: string;
  payment_hash: string;
  inbound: boolean;
  status: 'Pending' | 'Succeeded' | 'Failed';
  created_at: number;
  updated_at: number;
  payee_pubkey: string;
  preimage?: string;
}

/**
 * Response from getPayment API call
 */
export interface GetPaymentResponse {
  payment: PaymentDetails;
}

/**
 * Base RGB-LN API client interface
 */
export interface RLNClientInterface {
  decode(invoice: string): Promise<DecodeInvoiceResponse>;
  pay(invoice: string): Promise<PayInvoiceResponse>;
  getPayment(paymentHash: string): Promise<GetPaymentResponse>;
}
