import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { rpc } from './rpc.js';
import { config } from '../config.js';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(ecc);

interface UTXO {
  txid: string;
  vout: number;
  value: number;
}

interface RefundPSBTResult {
  psbtBase64: string;
  instructions: string;
}

/**
 * Build refund PSBT for user to sign after timelock expires
 * Witness will be: [User_sig, OP_FALSE, redeemScript]
 */
export async function buildRefundPsbtBase64(
  utxo: UTXO,
  redeemScript: Buffer,
  userRefundAddress: string,
  tLockHeight: number
): Promise<RefundPSBTResult> {
  // Determine network
  let network: bitcoin.Network;
  switch (config.NETWORK) {
    case 'mainnet':
      network = bitcoin.networks.bitcoin;
      break;
    case 'testnet':
    case 'signet':
      network = bitcoin.networks.testnet;
      break;
    case 'regtest':
      network = bitcoin.networks.regtest;
      break;
    default:
      throw new Error(`Unsupported network: ${config.NETWORK}`);
  }

  // Convert user refund address to output script
  const userOutputScript = bitcoin.address.toOutputScript(userRefundAddress, network);

  // Estimate fee
  const estimatedFee = 1000; // 1000 sats fee estimate
  const outputValue = utxo.value - estimatedFee;

  if (outputValue <= 1000) {
    throw new Error(
      `UTXO value too low: ${utxo.value} sats, need at least ${estimatedFee + 1000} sats`
    );
  }

  // Create PSBT
  const psbt = new bitcoin.Psbt({ network });

  // Add input
  const txHash = Buffer.from(utxo.txid, 'hex');

  // Get previous output details for witness utxo
  let prevTx;
  try {
    const txResult = await rpc.getRawTransaction(utxo.txid, true);
    if (!txResult || !txResult.vout || txResult.vout.length <= utxo.vout) {
      throw new Error(`Could not get output ${utxo.vout} from transaction ${utxo.txid}`);
    }

    prevTx = txResult;
  } catch (error) {
    console.error(`Error retrieving previous transaction. Will try with minimal witnessUtxo.`);
  }

  // Calculate witness script hash for this output (needed for P2WSH)
  const witnessScriptHash = bitcoin.crypto.sha256(redeemScript);
  const witnessScriptPubkey = bitcoin.script.compile([bitcoin.opcodes.OP_0, witnessScriptHash]);

  // Add witness UTXO
  const witnessUtxo = {
    script: witnessScriptPubkey,
    value: utxo.value
  };

  // Add PSBT input
  psbt.addInput({
    hash: txHash.reverse(),
    index: utxo.vout,
    sequence: 0xfffffffe, // Enable nSequence for timelock
    witnessScript: redeemScript,
    witnessUtxo: witnessUtxo,
    // RedeemScript hash for spending, not the full script
    redeemScript: redeemScript
  });

  // Set time lock properties
  psbt.setLocktime(tLockHeight);
  psbt.setInputSequence(0, 0xfffffffe);

  // Add output
  psbt.addOutput({
    script: userOutputScript,
    value: outputValue
  });

  // Note for signing instructions
  const instructions = `
Signing instructions:
1. Wait until block height reaches ${tLockHeight}
2. Sign input[0] with user's private key
3. Finalize witness with:
   - User signature (with SIGHASH_ALL)
   - OP_FALSE (refund path indicator)  
   - Redeem script
4. Final witness stack: [userSig, OP_FALSE, redeemScript]
5. Broadcast the transaction

WARNING: This transaction has timelock constraint.
Must wait until block ${tLockHeight} before it can be confirmed.
`;

  const psbtBase64 = psbt.toBase64();

  return {
    psbtBase64,
    instructions: instructions.trim()
  };
}
