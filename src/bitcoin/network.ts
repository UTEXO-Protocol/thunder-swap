import * as bitcoin from 'bitcoinjs-lib';
import { config } from '../config.js';

/**
 * Shared network selector based on config.NETWORK.
 */
export function getNetwork(): bitcoin.Network {
  switch (config.NETWORK) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
    case 'signet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
    default:
      throw new Error(`Unsupported network: ${config.NETWORK}`);
  }
}

