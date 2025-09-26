import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { DecodeInvoiceResponse, PayInvoiceResponse } from './types.js';

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
      
      if (result.status === 'succeeded' && !result.preimage) {
        console.warn('WARNING: Payment succeeded but no preimage returned by RGB-LN node');
        console.warn('You may need to update your RGB-LN implementation to include preimage in payment response');
      }

      return result;
    } catch (error: any) {
      const errorMsg = error?.response?.data?.error || error?.message || 'Payment failed';
      throw new Error(`RLN payment error: ${errorMsg}`);
    }
  }
}

/**
 * Export singleton instance
 */
export const rlnClient = new RLNClient();
