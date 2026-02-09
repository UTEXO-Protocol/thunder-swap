import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import {
  DecodeInvoiceResponse,
  PayInvoiceResponse,
  GetPaymentResponse,
  GetPaymentPreimageResponse,
  InvoiceHodlRequest,
  InvoiceHodlResponse,
  InvoiceSettleRequest,
  InvoiceCancelRequest,
  InvoiceStatusRequest,
  InvoiceStatusResponse,
  EmptyResponse,
  RgbInvoiceHtlcRequest,
  RgbInvoiceHtlcResponse,
  HtlcClaimRequest,
  HtlcClaimResponse,
  SendAssetRequest,
  SendAssetResponse,
  AssetBalanceRequest,
  AssetBalanceResponse,
  AssetMetadataRequest,
  AssetMetadataResponse,
  DecodeRgbInvoiceResponse,
  WitnessData
} from './types.js';
import { parse } from 'dotenv';
import { readFileSync } from 'fs';

/**
 * RGB-LN API client for invoice decode and payment
 */
export class RLNClient {
  private httpClient: AxiosInstance; // RLN L2 client
  private httpClientL1: AxiosInstance; // RLN L1 client
  private httpClientL2Lp: AxiosInstance; // LP RLN L2 client

  constructor() {
    // RLN L2 client for current role
    this.httpClient = axios.create({
      baseURL: config.RLN_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        ...(config.RLN_API_KEY && {
          Authorization: `Bearer ${config.RLN_API_KEY}`
        })
      }
    });

    // RLN L1 client for current role
    this.httpClientL1 = axios.create({
      baseURL: config.RLN_BASE_URL_L1,
      headers: {
        'Content-Type': 'application/json',
        ...(config.RLN_API_KEY_L1 && {
          Authorization: `Bearer ${config.RLN_API_KEY_L1}`
        })
      }
    });

    // RLN L2 client for LP - from .env.lp
    const lpEnv = parse(readFileSync('.env.lp')); // does not overwrite process.env
    const lpL2Base = lpEnv.RLN_BASE_URL;
    const lpL2Key = lpEnv.RLN_API_KEY;

    this.httpClientL2Lp = axios.create({
      baseURL: lpL2Base,
      headers: {
        'Content-Type': 'application/json',
        ...(lpL2Key && {
          Authorization: `Bearer ${lpL2Key}`
        })
      }
    });
  }

  /**
   * Decode RGB-LN invoice to extract payment details
   */
  async decode(invoice: string): Promise<DecodeInvoiceResponse> {
    try {
      console.log('Decoding RGB-LN invoice...');

      const response = await this.httpClient.post('/decodelninvoice', {
        invoice
      });

      return response.data;
    } catch (error: any) {
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to decode invoice';
      throw new Error(`RLN decode error: ${errorMsg}`);
    }
  }

  async decodeRgbInvoice(invoice: string): Promise<DecodeRgbInvoiceResponse> {
    try {
      console.log('Decoding RGB invoice...');

      const response = await this.httpClientL1.post('/decodergbinvoice', {
        invoice
      });

      console.log(JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error: any) {
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to decode invoice';
      throw new Error(`RLN decode error: ${errorMsg}`);
    }
  }

  /**
   * Pay RGB-LN invoice and return preimage on successful payment
   */
  async pay(invoice: string): Promise<PayInvoiceResponse> {
    try {
      console.log('Paying RGB-LN invoice...');

      const response = await this.httpClient.post('/sendpayment', {
        invoice
      });

      const result = response.data;
      console.log('PayInvoiceResponse', result);

      if (result.status === 'Pending') {
        console.warn('WARNING: Payment succeeded but no preimage returned by RGB-LN node');
      }

      return result;
    } catch (error: any) {
      const errorMsg = error?.response?.data?.error || error?.message || 'Payment failed';
      throw new Error(`RLN payment error: ${errorMsg}`);
    }
  }

  /**
   * Get payment details by payment hash, including preimage if available
   */
  async getPayment(paymentHash: string): Promise<GetPaymentResponse> {
    try {
      console.log(`   Getting payment details for hash: ${paymentHash}...\n`);

      const response = await this.httpClient.post('/getpayment', {
        payment_hash: paymentHash
      });

      console.log('GetPaymentResponse', response.data);
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to get payment details';
      throw new Error(`RLN getPayment error: ${errorMsg}`);
    }
  }

  /**
   * Get outbound payment status and preimage (when available) by payment hash
   */
  async getPaymentPreimage(paymentHash: string): Promise<GetPaymentPreimageResponse> {
    try {
      const response = await this.httpClient.post('/getpaymentpreimage', {
        payment_hash: paymentHash
      });
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to get payment preimage';
      throw new Error(`RLN getPaymentPreimage error: ${errorMsg}`);
    }
  }

  /**
   * Create a HODL invoice with a client-provided payment hash
   * Settlement is deferred until settle/cancel is called
   */
  async invoiceHodl(request: InvoiceHodlRequest): Promise<InvoiceHodlResponse> {
    try {
      console.log(`invoiceHodl → POST ${this.httpClient.defaults.baseURL}/hodlinvoice`);
      console.log('invoiceHodl payload:', JSON.stringify(request));
      const response = await this.httpClient.post('/hodlinvoice', request);

      // console.log('InvoiceHodlResponse', response.data);
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to create HODL invoice';
      throw new Error(`RLN invoiceHodl error: ${errorMsg}`);
    }
  }

  /**
   * Settle a HODL invoice by claiming the RLN-held HTLC
   */
  async invoiceSettle(request: InvoiceSettleRequest): Promise<EmptyResponse> {
    try {
      console.log(`   Settling HODL invoice for payment hash: ${request.payment_hash}...`);

      const response = await this.httpClient.post('/settlehodlinvoice', request);

      console.log('   Invoice settled successfully');
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to settle HODL invoice';
      throw new Error(`RLN invoice settlement error: ${errorMsg}`);
    }
  }

  /**
   * Cancel a HODL invoice by failing the RLN-held HTLC backwards
   */
  async invoiceCancel(request: InvoiceCancelRequest): Promise<EmptyResponse> {
    try {
      console.log(`Canceling HODL invoice for payment hash: ${request.payment_hash}...`);

      const response = await this.httpClient.post('/cancelhodlinvoice', request);

      console.log('Invoice canceled successfully');
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to cancel HODL invoice';
      throw new Error(`RLN invoiceCancel error: ${errorMsg}`);
    }
  }

  /**
   * Get invoice status by invoice string
   */
  async invoiceStatus(request: InvoiceStatusRequest): Promise<InvoiceStatusResponse> {
    try {
      const response = await this.httpClient.post('/invoicestatus', request);
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to get invoice status';
      throw new Error(`RLN invoiceStatus error: ${errorMsg}`);
    }
  }

  /**
   * Create an RGB invoice bound to an HTLC P2TR scriptPubKey (USER role → L1 backend)
   */
  async rgbInvoiceHtlc(request: RgbInvoiceHtlcRequest): Promise<RgbInvoiceHtlcResponse> {
    try {
      console.log(`   rgbInvoiceHtlc → POST ${this.httpClientL1.defaults.baseURL}/rgbinvoicehtlc`);
      const client = this.httpClientL1;
      const response = await client.post('/rgbinvoicehtlc', request);

      console.log(`\nrgbInvoiceResponse: ${JSON.stringify(response.data, null, 2)}`);
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to create RGB HTLC invoice';
      throw new Error(`rgbInvoiceHtlc error: ${errorMsg}`);
    }
  }

  /**
   * Claim HTLC on-chain via RLN L1 (LP role)
   */
  async htlcClaim(request: HtlcClaimRequest): Promise<HtlcClaimResponse> {
    try {
      const client = this.httpClientL1;
      const response = await client.post('/htlcclaim', request);
      return response.data;
    } catch (error: any) {
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to claim HTLC';
      throw new Error(`RLN htlcclaim error: ${errorMsg}`);
    }
  }

  /**
   * Send RGB assets using an RGB HTLC invoice on L1
   */
  async sendAsset(invoice: string): Promise<SendAssetResponse> {
    try {
      const client = this.httpClientL1;

      const decode = await client.post('/decodergbinvoice', { invoice });

      await client.post('/refreshtransfers', { skip_sync: false });

      const witness_data: WitnessData = {
        amount_sat: 1000,
      }
      const request: SendAssetRequest = {
        asset_id: decode.data.asset_id,
        assignment: decode.data.assignment,
        recipient_id: decode.data.recipient_id,
        witness_data,
        donation: true,
        fee_rate: 1,
        min_confirmations: 1,
        transport_endpoints: decode.data.transport_endpoints,
        skip_sync: false,
      };
      console.log('/sendasset payload:', JSON.stringify(request, null, 2));
      const response = await client.post('/sendasset', request);

      await client.post('/refreshtransfers', { skip_sync: false });

      return response.data;
    } catch (error: any) {
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to send asset';
      throw new Error(`RLN sendasset error: ${errorMsg}`);
    }
  }

  /**
   * Query RGB asset balance (role-agnostic)
   */
  async assetBalance(
    request: AssetBalanceRequest,
    role: 'USER' | 'LP',
    layer: 'L1' | 'L2' = 'L1'
  ): Promise<AssetBalanceResponse> {
    try {
      // USER -> L1 client; LP -> L2 client
      const client =
        role === 'USER' && layer === 'L2' ? this.httpClient :
          role === 'USER' ? this.httpClientL1 :
            this.httpClientL2Lp;
      const response = await client.post('/assetbalance', request);
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to fetch asset balance';
      throw new Error(`RLN assetbalance error: ${errorMsg}`);
    }
  }

  /**
   * Fetch RGB asset metadata
   */
  async assetMetadata(
    request: AssetMetadataRequest,
    role: 'USER' | 'LP',
    layer: 'L1' | 'L2' = 'L1'
  ): Promise<AssetMetadataResponse> {
    try {
      const client =
        role === 'USER' && layer === 'L2' ? this.httpClient :
          role === 'USER' ? this.httpClientL1 :
            this.httpClientL2Lp;
      const response = await client.post('/assetmetadata', request);
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to fetch asset metadata';
      throw new Error(`RLN assetmetadata error: ${errorMsg}`);
    }
  }
}

/**
 * Export singleton instance
 */
export const rlnClient = new RLNClient();
