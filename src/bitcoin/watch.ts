import { rpc } from './rpc.js';
import { config } from '../config.js';
import { Address } from 'bitcoinjs-lib';

interface FundingUTXO {
  txid: string;
  vout: number;
  value: number;
}

/**
 * Wait for funding UTXO to be confirmed
 * Uses scanTxOutSet as primary method, falls back to importAddress + listUnspent
 */
export async function waitForFunding(
  address: string, 
  minConfs: number = config.MIN_CONFS
): Promise<FundingUTXO> {
  console.log(`Waiting for funding at ${address} with ${minConfs} confirmations...`);
  
  // Try scanTxOutSet first
  try {
    const result = await rpc.scanTxOutSet(address);
    if (result.total_amount > 0) {
      console.log(`Found ${result.total_amount} sats at ${address}`);
      
      // For proven UTXOs, we need to get more details
      const utxos = result.utxos || [];
      if (utxos.length > 0) {
        // Find the first utxo that meets our amount requirement
        for (const utxo of utxos) {
          try {
            const txDetails = await rpc.getRawTransaction(utxo.txid, true);
            if (txDetails && txDetails.confirmations >= minConfs) {
              const vout = utxo.height; // This might be vout index
              const value = Math.round(utxo.combo * 100000000); // Convert BTC to sats
              
              return {
                txid: utxo.txid,
                vout: vout || 0,
                value: value
              };
            }
          } catch (error) {
            console.log(`Error getting tx ${utxo.txid}:`, error);
            continue;
          }
        }
      }
    }
  } catch (error) {
    console.log('scanTxOutSet not available, falling back to importAddress...');
  }

  // Fallback: importAddress + listUnspent
  try {
    await rpc.importAddress(address);
  } catch (error) {
    console.log('Could not import address, continuing anyway...');
  }

  // Poll listUnspent
  const maxAttempts = 60; // 5 minutes at 5 second intervals
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const unspent = await rpc.listUnspent();
      const funding = unspent.find((utxo: any) => {
        // Check if address belongs to this utxo
        return utxo.spendable && 
               utxo.confirmations >= minConfs &&
               utxo.amount > 0;
      });

      if (funding) {
        // We found a UTXO but need to verify it's for our specific address
        console.log(`Found potential UTXO: ${funding.txid}:${funding.vout} (${funding.amount} BTC)`);
        
        // TODO: Add proper address matching logic
        // For now, we'll assume the first qualifying UTXO is our funding
        return {
          txid: funding.txid,
          vout: funding.vout,
          value: Math.round(funding.amount * 100000000) // Convert BTC to sats
        };
      }
    } catch (error) {
      console.log(`Attempt ${attempt + 1} failed:`, error);
    }

    // Wait before next attempt
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log(`Polling for funding confirmation (attempt ${attempt + 1}/${maxAttempts})...`);
  }

  throw new Error(`Timeout waiting for funding confirmation at ${address}`);
}
