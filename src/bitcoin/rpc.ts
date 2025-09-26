import axios from 'axios';
import { config } from '../config.js';

interface RPCResponse<T = any> {
  result: T;
  error?: {
    code: number;
    message: string;
  };
}

interface BitcoinRPCClient {
  getBlockCount(): Promise<number>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<any>;
  sendRawTransaction(hex: string): Promise<string>;
  scanTxOutSet(address: string): Promise<any>;
  listUnspent(minconf?: number, maxconf?: number, addresses?: string[]): Promise<any[]>;
  importAddress(address: string): Promise<void>;
}

class BitcoinRPCClientImpl implements BitcoinRPCClient {
  private baseUrl: string;
  private user: string;
  private pass: string;

  constructor() {
    this.baseUrl = config.BITCOIN_RPC_URL;
    this.user = config.BITCOIN_RPC_USER;
    this.pass = config.BITCOIN_RPC_PASS;
  }

  private async rpcCall<T = any>(method: string, params: any[] = []): Promise<T> {
    const response = await axios.post<RPCResponse<T>>(
      this.baseUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method,
        params
      },
      {
        auth: {
          username: this.user,
          password: this.pass
        }
      }
    );

    if (response.data.error) {
      throw new Error(`RPC Error: ${response.data.error.message} (code: ${response.data.error.code})`);
    }

    return response.data.result;
  }

  async getBlockCount(): Promise<number> {
    return this.rpcCall<number>('getblockcount');
  }

  async getRawTransaction(txid: string, verbose = false): Promise<any> {
    return this.rpcCall('getrawtransaction', [txid, verbose]);
  }

  async sendRawTransaction(hex: string): Promise<string> {
    return this.rpcCall<string>('sendrawtransaction', [hex]);
  }

  async scanTxOutSet(address: string): Promise<any> {
    return this.rpcCall('scantxoutset', ['start', [{ 'desc': `addr(${address})` }]]);
  }

  async listUnspent(minconf = 0, maxconf = 9999999, addresses: string[] = []): Promise<any[]> {
    const params = [minconf, maxconf];
    if (addresses.length > 0) {
      params.push(addresses);
    }
    return this.rpcCall('listunspent', params);
  }

  async importAddress(address: string): Promise<void> {
    return this.rpcCall('importaddress', [address, '', false]);
  }
}

// Export singleton instance
export const rpc = new BitcoinRPCClientImpl();
