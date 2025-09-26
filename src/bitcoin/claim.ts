import * as bitcoin from 'bitcoinjs-lib';
import { rpc } from './rpc.js';
import { config } from '../config.js';
import { hexToBuffer, sha256hex } from '../utils/crypto.js';

interface UTXO {
  txid: string;
  vout: number;
  value: number;
}

interface ClaimResult {
  txid: string;
  hex: string;
}

/**
 * Claim HTLC with preimage witness
 * Witness stack: [LP_sig, preimage, OP_TRUE, redeemScript]
 */
export async function claimWithPreimage(
  utxo: UTXO,
  redeemScript: Buffer,
  preimageHex: string,
  lpWif: string,
  lpClaimAddress: string
): Promise<ClaimResult> {
  // Validate inputs
  if (!preimageHex.match(/^[0-9a-fA-F]*$/) || preimageHex.length === 0) {
    throw new Error('Preimage must be valid hex');
  }
  
  const preimage = hexToBuffer(preimageHex);
  
  // Parse WIF
  let lpKeyPair: bitcoin.ECPairInterface;
  try {
    lpKeyPair = bitcoin.ECPair.fromWIF(lpWif);
  } catch (error) {
    throw new Error(`Invalid LP WIF: ${error}`);
  }

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

  // Create refund transaction
  const tx = new bitcoin.Transaction();
  tx.version = 2;

  // Add input
  const txHash = Buffer.from(utxo.txid, 'hex').reverse();
  const txInput = {
    hash: txHash,
    index: utxo.vout,
    sequence: 0xffffffff
  };
  tx.addInput(txInput.hash, txInput.index, txInput.sequence);

  // Create output to our claim address
  const claimAddress = bitcoin.address.toOutputScript(lpClaimAddress, network);
  
  // Estimate fee (simple estimate, could be improved with Bitcoin Core fee estimation)
  const estimatedFee = 1000; // 1000 sats fee estimate
  const outputValue = utxo.value - estimatedFee;
  
  if (outputValue <= 1000) {
    throw new Error(`UTXO value too low: ${utxo.value} sats, need at least ${estimatedFee + 1000} sats`);
  }

  tx.addOutput(claimAddress, outputValue);

  // Build witness for Stealth path (with preimage)
  // Witness: [LP_sig, preimage, OP_TRUE, redeemScript]
  
  const preimageHash = sha256hex(preimage);
  console.log(`Using preimage hash: ${preimageHash}`);

  // Create transaction for signing (get hash to sign)
  const redeemTx = tx.clone();
  
  // Sign the transaction
  const hashType = bitcoin.Transaction.SIGHASH_ALL;
  const signatureHash = redeemTx.hashForWitnessV0(
    0, // input index
    redeemScript,
    utxo.value,
    hashType
  );
  
  const signature = lpKeyPair.sign(signatureHash);
  const signatureWithHashType = Buffer.concat([signature, Buffer.from([hashType])]);
  
  // Build witness stack
  // [LP_sig, preimage, OP_TRUE, redeemScript]
  const witness: Buffer[] = [
    signatureWithHashType,  // LP signature
    preimage,               // Secret preimage
    Buffer.from([1]),       // OP_TRUE for claiming path
    redeemScript            // Full redeem script
  ];

  // Set witness on the transaction
  tx.setWitness(0, witness);

  // Serialize
  const rawTx = tx.toHex();
  
  // Broadcast transaction
  try {
    const txid = await rpc.sendRawTransaction(rawTx);
    console.log(`Claim transaction broadcast: ${txid}`);
    
    return {
      txid,
      hex: rawTx
    };
  } catch (error) {
    throw new Error(`Failed to broadcast claim transaction: ${error}`);
  }
}
