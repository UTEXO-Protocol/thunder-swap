import { rpc } from './rpc.js';
import { config } from '../config.js';

interface FundingUTXO {
  txid: string;
  vout: number;
  value: number;
}

/**
 * Wait for funding UTXO to be confirmed
 * Uses scanTxOutSet to monitor for incoming transactions to the HTLC address
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
      const utxos = result.unspents || [];
      if (utxos.length > 0) {
        // Find the first utxo that meets our amount requirement
        for (const utxo of utxos) {
          try {
            const txDetails = await rpc.getRawTransaction(utxo.txid, true);
            if (txDetails && txDetails.confirmations >= minConfs) {
              const vout = utxo.vout; // This might be vout index
              const value = Math.round(utxo.amount * 100000000); // Convert BTC to sats
              
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
    console.log('scanTxOutSet not available, falling back to transaction monitoring...');
  }

  // Fallback: Use getrawtransaction to check for funding
  // Note: We don't import the HTLC address as it's not owned by our wallet
  console.log('Using transaction monitoring fallback...');
  
  const maxAttempts = 60; // 5 minutes at 5 second intervals
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Get recent block hash and check recent transactions
      // This is a simplified approach - in production you'd want to use
      // a more sophisticated method like watching the mempool or using
      // a block explorer API
      
      // For now, we'll use scanTxOutSet again as it should work for watching
      const result = await rpc.scanTxOutSet(address);
      if (result.total_amount > 0) {
        const utxos = result.unspents || [];
        if (utxos.length > 0) {
          // Find the first utxo that meets our confirmation requirement
          for (const utxo of utxos) {
            try {
              const txDetails = await rpc.getRawTransaction(utxo.txid, true);
              if (txDetails && txDetails.confirmations >= minConfs) {
                const value = Math.round(utxo.amount * 100000000); // Convert BTC to sats
                
                return {
                  txid: utxo.txid,
                  vout: utxo.vout || 0, 
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
      console.log(`Attempt ${attempt + 1} failed:`, error);
    }

    // Wait before next attempt
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log(`Polling for funding confirmation (attempt ${attempt + 1}/${maxAttempts})...`);
  }

  throw new Error(`Timeout waiting for funding confirmation at ${address}`);
}
