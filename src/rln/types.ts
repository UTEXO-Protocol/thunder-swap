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
  status: 'Succeeded' | 'Failed' | 'Pending';
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
  status: 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed';
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
 * Request for getting outbound payment preimage by hash
 */
export interface GetPaymentPreimageRequest {
  payment_hash: string;
}

/**
 * Response from getPaymentPreimage API call
 */
export interface GetPaymentPreimageResponse {
  status: 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed' | 'Timeout';
  preimage?: string | null;
}

/**
 * Request for creating a HODL invoice
 */
export interface InvoiceHodlRequest {
  payment_hash: string;
  expiry_sec: number;
  amt_msat?: number;
  asset_id?: string;
  asset_amount?: number;
  external_ref?: string;
}

/**
 * Response from creating a HODL invoice
 */
export interface InvoiceHodlResponse {
  invoice: string;
  payment_secret: string;
}

/**
 * Request for settling a HODL invoice
 */
export interface InvoiceSettleRequest {
  payment_hash: string;
  payment_preimage: string;
}

/**
 * Request for canceling a HODL invoice
 */
export interface InvoiceCancelRequest {
  payment_hash: string;
}

/**
 * Request for getting invoice status
 */
export interface InvoiceStatusRequest {
  invoice: string;
}

/**
 * Response from invoice status API call
 */
export interface InvoiceStatusResponse {
  status: 'Pending' | 'Succeeded' | 'Cancelled' | 'Failed' | 'Expired';
}

/**
 * Empty response for settle/cancel operations
 */
export interface EmptyResponse {}

/**
 * Base RGB-LN API client interface
 */
export interface RLNClientInterface {
  decode(invoice: string): Promise<DecodeInvoiceResponse>;
  pay(invoice: string): Promise<PayInvoiceResponse>;
  getPayment(paymentHash: string): Promise<GetPaymentResponse>;
  getPaymentPreimage(paymentHash: string): Promise<GetPaymentPreimageResponse>;
  invoiceHodl(request: InvoiceHodlRequest): Promise<InvoiceHodlResponse>;
  invoiceSettle(request: InvoiceSettleRequest): Promise<EmptyResponse>;
  invoiceCancel(request: InvoiceCancelRequest): Promise<EmptyResponse>;
  invoiceStatus(request: InvoiceStatusRequest): Promise<InvoiceStatusResponse>;
}
