import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import {
  DecodeInvoiceResponse,
  PayInvoiceResponse,
  GetPaymentResponse,
  InvoiceHodlRequest,
  InvoiceHodlResponse,
  InvoiceSettleRequest,
  InvoiceCancelRequest,
  EmptyResponse
} from './types.js';

/**
 * RGB-LN API client for invoice decode and payment
 */
export class RLNClient {
  private httpClient: AxiosInstance;

  constructor() {
    this.httpClient = axios.create({
      baseURL: config.RLN_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        ...(config.RLN_API_KEY && {
          'Authorization': `Bearer ${config.RLN_API_KEY}`
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
        console.warn('You may need to update your RGB-LN implementation to include preimage in payment response');
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
      const errorMsg = error?.response?.data?.error || error?.message || 'Failed to get payment details';
      throw new Error(`RLN getPayment error: ${errorMsg}`);
    }
  }

  /**
   * Create a HODL invoice with a client-provided payment hash
   * Settlement is deferred until settle/cancel is called
   */
  async invoiceHodl(request: InvoiceHodlRequest): Promise<InvoiceHodlResponse> {
    try {
      const response = await this.httpClient.post('/invoice/hodl', request);

      console.log('InvoiceHodlResponse', response.data);
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

      const response = await this.httpClient.post('/invoice/settle', request);

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

      const response = await this.httpClient.post('/invoice/cancel', request);

      console.log('Invoice canceled successfully');
      return response.data;
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.error || error?.message || 'Failed to cancel HODL invoice';
      throw new Error(`RLN invoiceCancel error: ${errorMsg}`);
    }
  }
}

/**
 * Export singleton instance
 */
export const rlnClient = new RLNClient();
