/**
 * Response from decode invoice API call
 */
export interface DecodeInvoiceResponse {
  amt_msat?: number | null;
  expiry_sec: number;
  timestamp: number;
  asset_id?: string | null;
  asset_amount?: number | null;
  payment_hash: string;
  payment_secret: string;
  payee_pubkey?: string | null;
  network: BitcoinNetwork;
}

export interface DecodeRgbInvoiceResponse {
  recipient_id: string;
  recipient_type: RecipientType;
  asset_schema?: AssetSchema | null;
  asset_id?: string | null;
  assignment: Assignment;
  network: BitcoinNetwork;
  expiration_timestamp?: number | null;
  transport_endpoints: string[];
}

export type BitcoinNetwork = 'Mainnet' | 'Testnet' | 'Testnet4' | 'Signet' | 'Regtest';

/**
 * Response from pay invoice API call
 */
export interface PayInvoiceResponse {
  payment_id: string;
  payment_hash?: string | null;
  payment_secret?: string | null;
  status: HTLCStatus;
}

/**
 * Payment details from getPayment API call
 */
export interface PaymentDetails {
  amt_msat?: number | null;
  asset_amount?: number | null;
  asset_id?: string | null;
  payment_hash: string;
  inbound: boolean;
  status: HTLCStatus;
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
  status: HTLCStatus;
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
export interface EmptyResponse { }

export interface RefreshTransfersRequest {
  skip_sync: boolean;
}

/**
 * Base RGB-LN API client interface
 */
export interface RLNClientInterface {
  decode(invoice: string): Promise<DecodeInvoiceResponse>;
  decodeRgbInvoice(invoice: string): Promise<DecodeRgbInvoiceResponse>;
  pay(invoice: string): Promise<PayInvoiceResponse>;
  getPayment(paymentHash: string): Promise<GetPaymentResponse>;
  getPaymentPreimage(paymentHash: string): Promise<GetPaymentPreimageResponse>;
  invoiceHodl(request: InvoiceHodlRequest): Promise<InvoiceHodlResponse>;
  invoiceSettle(request: InvoiceSettleRequest): Promise<EmptyResponse>;
  invoiceCancel(request: InvoiceCancelRequest): Promise<EmptyResponse>;
  invoiceStatus(request: InvoiceStatusRequest): Promise<InvoiceStatusResponse>;
  rgbInvoiceHtlc(request: RgbInvoiceHtlcRequest): Promise<RgbInvoiceHtlcResponse>;
  htlcScan(request: HtlcScanRequest): Promise<HtlcScanResponse>;
  htlcClaim(request: HtlcClaimRequest): Promise<HtlcClaimResponse>;
  refreshTransfers(request: RefreshTransfersRequest): Promise<EmptyResponse>;
  sendAsset(invoice: string, overrides?: Partial<SendAssetRequest>): Promise<SendAssetResponse>;
  assetBalance(
    request: AssetBalanceRequest,
    role: 'USER' | 'LP',
    layer?: 'L1' | 'L2'
  ): Promise<AssetBalanceResponse>;
  assetMetadata(
    request: AssetMetadataRequest,
    role: 'USER' | 'LP',
    layer?: 'L1' | 'L2'
  ): Promise<AssetMetadataResponse>;
}

export type AssignmentType = 'Fungible' | 'NonFungible' | 'InflationRight' | 'ReplaceRight' | 'Any';

export interface Assignment {
  type: AssignmentType;
  value?: number; // for Fungible/InflationRight
}

export interface RgbInvoiceHtlcRequest {
  asset_id?: string;
  assignment?: Assignment;
  duration_seconds?: number;
  min_confirmations?: number;
  payment_hash: string; // 32-byte hex
  user_pubkey: string; // compressed pubkey hex (refund key)
  csv: number; // relative timelock in blocks
}

export interface RgbInvoiceHtlcResponse {
  recipient_id: string;
  invoice: string;
  expiration_timestamp?: number;
  batch_transfer_idx: number;
  htlc_p2tr_script_pubkey: string; // hex
  htlc_p2tr_address?: string;
  htlc_p2tr_internal_key_hex?: string;
  t_lock?: number;
}

export interface HtlcClaimRequest {
  payment_hash: string;
  preimage: string;
}

export interface HtlcClaimResponse { }

export interface HtlcScanRequest {
  payment_hash: string;
}

export interface HtlcScanResponse { }

export interface WitnessData {
  amount_sat: number;
  blinding?: number;
}

// RGB asset transfer (sendasset)
export interface SendAssetRequest {
  asset_id: string;
  assignment: Assignment;
  recipient_id: string;
  witness_data?: WitnessData;
  donation: boolean;
  fee_rate: number;
  min_confirmations: number;
  transport_endpoints: string[];
  skip_sync: boolean;
}

export interface SendAssetResponse {
  txid: string;
}

// RGB balance query (assetbalance)
export interface AssetBalanceRequest {
  asset_id: string;
}

export interface AssetBalanceResponse {
  settled: number;
  future: number;
  spendable: number;
  offchain_outbound: number;
  offchain_inbound: number;
}

export interface AssetMetadataRequest {
  asset_id: string;
}

export interface AssetMetadataResponse {
  asset_schema: AssetSchema;
  initial_supply: number;
  max_supply: number;
  known_circulating_supply: number;
  timestamp: number;
  name: string;
  precision: number;
  ticker?: string | null;
  details?: string | null;
  token?: Token | null;
}

export type AssetSchema = 'Nia' | 'Uda' | 'Cfa';
export type RecipientType = 'Blind' | 'Witness';

export interface Token {
  index: number;
  ticker?: string | null;
  name?: string | null;
  details?: string | null;
  embedded_media?: unknown | null;
  media?: unknown | null;
  attachments?: Record<string, unknown>;
  reserves?: unknown | null;
}

export type HTLCStatus = 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed';
