import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import { config } from '../config.js';
import { isValidHex } from '../utils/crypto.js';
import { getNetwork } from './network.js';

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
  getTransactionOutput(
    txid: string,
    vout: number,
    options?: GetTransactionOutputOptions
  ): Promise<TransactionOutput>;
}

export interface GetTransactionOutputOptions {
  expectedAddress?: string;
  expectedScriptPubKeyHex?: string;
  requireUnspent?: boolean;
  network?: bitcoin.Network;
}

export interface TransactionOutput {
  scriptPubKey: {
    asm: string;
    hex: string;
    reqSigs?: number;
    type: string;
    addresses?: string[];
    address?: string;
  };
  value: number; // BTC amount
  n: number; // vout index
}

const TXID_REGEX = /^[0-9a-fA-F]{64}$/;

function assertValidTxid(txid: string): void {
  if (!TXID_REGEX.test(txid)) {
    throw new Error('txid must be a 64-character hex string');
  }
}

function assertValidVout(vout: number): void {
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('vout must be a non-negative integer');
  }

  if (vout > 0xffffffff) {
    throw new Error('vout must be <= 0xffffffff');
  }
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

function isValidHexBytes(hex: string): boolean {
  return isValidHex(hex) && hex.length % 2 === 0;
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

  private async rpcCall<T = any>(method: string, params: any[] = [], wallet?: string): Promise<T> {
    // Use wallet-specific endpoint if wallet is specified
    const url = wallet ? `${this.baseUrl}/wallet/${wallet}` : this.baseUrl;

    const response = await axios.post<RPCResponse<T>>(
      url,
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
      throw new Error(
        `RPC Error: ${response.data.error.message} (code: ${response.data.error.code})`
      );
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
    return this.rpcCall('scantxoutset', ['start', [{ desc: `addr(${address})` }]]);
    // TODO: review if should be return this.rpcCall('scantxoutset', ['start', [`addr(${address})`]]);
  }

  async listUnspent(minconf = 0, maxconf = 9999999, addresses: string[] = []): Promise<any[]> {
    const params: any[] = [minconf, maxconf];
    if (addresses.length > 0) {
      params.push(addresses);
    }
    return this.rpcCall('listunspent', params, 'swap');
  }

  async importAddress(address: string): Promise<void> {
    return this.rpcCall('importaddress', [address, '', false], 'swap');
  }

  private async getTxOut(txid: string, vout: number, includeMempool = true): Promise<any | null> {
    return this.rpcCall('gettxout', [txid, vout, includeMempool]);
  }

  /**
   * Get specific transaction output details
   * Returns output at specified vout index including scriptPubKey and value
   */
  async getTransactionOutput(
    txid: string,
    vout: number,
    options: GetTransactionOutputOptions = {}
  ): Promise<TransactionOutput> {
    assertValidTxid(txid);
    assertValidVout(vout);

    const tx = await this.getRawTransaction(txid, true);

    if (!tx || !tx.vout || vout >= tx.vout.length) {
      throw new Error(`Output ${vout} not found in transaction ${txid}`);
    }

    const output = tx.vout[vout] as TransactionOutput;
    if (!output || output.n !== vout) {
      throw new Error(`Output ${vout} not found in transaction ${txid}`);
    }

    if (!output.scriptPubKey || !output.scriptPubKey.hex) {
      throw new Error(`Output ${vout} is missing scriptPubKey data`);
    }

    if (!isValidHexBytes(output.scriptPubKey.hex)) {
      throw new Error(`Output ${vout} has invalid scriptPubKey hex`);
    }

    if (options.requireUnspent ?? true) {
      const utxo = await this.getTxOut(txid, vout, true);
      if (!utxo) {
        throw new Error(`Output ${vout} in ${txid} is spent or missing`);
      }
    }

    if (options.expectedScriptPubKeyHex) {
      if (!isValidHexBytes(options.expectedScriptPubKeyHex)) {
        throw new Error('expectedScriptPubKeyHex must be valid hex');
      }

      if (normalizeHex(options.expectedScriptPubKeyHex) !== normalizeHex(output.scriptPubKey.hex)) {
        throw new Error(`Output ${vout} scriptPubKey does not match expected script`);
      }
    }

    if (options.expectedAddress) {
      const network = options.network ?? getNetwork();
      const expectedAddress = options.expectedAddress.trim();
      if (!expectedAddress) {
        throw new Error('expectedAddress must be a non-empty string');
      }

      let expectedOutput: Buffer;
      try {
        expectedOutput = bitcoin.address.toOutputScript(expectedAddress, network);
      } catch (error) {
        throw new Error(`Invalid expectedAddress ${expectedAddress}: ${error}`);
      }

      const actualOutput = Buffer.from(output.scriptPubKey.hex, 'hex');
      if (!expectedOutput.equals(actualOutput)) {
        throw new Error(`Output ${vout} scriptPubKey does not match expected address`);
      }
    }

    return output;
  }
}

// Export singleton instance
export const rpc = new BitcoinRPCClientImpl();
