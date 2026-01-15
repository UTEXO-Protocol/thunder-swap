import { rpc } from "./rpc.js";
import { config } from "../config.js";
import {
  P2TRHTLCTemplate,
  buildClaimTapscript,
  buildRefundTapscript,
  reconstructP2TRScriptPubKey,
} from "./htlc_p2tr.js";
import { hexToBuffer, bufferToHex } from "../utils/crypto.js";

export interface FundingTransactionInfo {
  txid: string;
  vout: number;
}

export interface P2TRHTLCIdentification {
  outpoint: {
    txid: string;
    vout: number;
  };
  amount: number; // in sats
  cltv_expiry: number;
}

/**
 * Convert millisatoshis to satoshis
 */
function msatToSat(msat: number): number {
  return Math.ceil(msat / 1000);
}

/**
 * Reconstruct expected P2TR scriptPubKey from template
 * This matches what should be on-chain
 */
function reconstructExpectedScriptPubKey(template: P2TRHTLCTemplate): Buffer {
  return reconstructP2TRScriptPubKey(template);
}

/**
 * Verify funding transaction and extract HTLC identification
 * Main verification function for operator to verify user-provided funding transaction
 */
export async function verifyFundingTransaction(
  fundingInfo: FundingTransactionInfo,
  template: P2TRHTLCTemplate,
  invoiceAmountMsat: number,
  minConfs: number = config.MIN_CONFS
): Promise<P2TRHTLCIdentification> {
  // Step 1: Fetch transaction from blockchain
  let txDetails;
  try {
    txDetails = await rpc.getRawTransaction(fundingInfo.txid, true);
  } catch (error) {
    throw new Error(
      `Failed to fetch transaction ${fundingInfo.txid}: ${error}`
    );
  }

  // Step 2: Verify transaction is confirmed
  if (!txDetails.confirmations || txDetails.confirmations < minConfs) {
    throw new Error(
      `Transaction ${fundingInfo.txid} has ${txDetails.confirmations || 0} confirmations, required ${minConfs}`
    );
  }

  // Step 3: Verify template parameters are valid
  // Build expected scripts to ensure template is well-formed
  const expectedClaimScript = buildClaimTapscript(
    template.payment_hash,
    template.lp_pubkey
  );
  const expectedRefundScript = buildRefundTapscript(
    template.cltv_expiry,
    template.user_pubkey
  );

  // Verify scripts were built successfully (implicitly validates parameters)
  if (expectedClaimScript.length === 0 || expectedRefundScript.length === 0) {
    throw new Error("Failed to build expected HTLC scripts from template");
  }

  const expectedScriptPubKey = reconstructExpectedScriptPubKey(template);

  // Step 4: Extract output at specified vout
  let output;
  try {
    output = await rpc.getTransactionOutput(fundingInfo.txid, fundingInfo.vout, {
      expectedScriptPubKeyHex: bufferToHex(expectedScriptPubKey),
      requireUnspent: true,
    });
  } catch (error) {
    throw new Error(
      `Failed to get output ${fundingInfo.vout} from transaction ${fundingInfo.txid}: ${error}`
    );
  }

  // Step 5: Verify output exists and extract amount
  const amountSat = Math.round(output.value * 100000000); // Convert BTC to sats
  const invoiceAmountSat = msatToSat(invoiceAmountMsat);

  // Step 6: Verify amount >= invoice amount
  if (amountSat < invoiceAmountSat) {
    throw new Error(
      `Insufficient amount: output has ${amountSat} sats, invoice requires at least ${invoiceAmountSat} sats (${invoiceAmountMsat} msat)`
    );
  }

  // Step 7: Verify scriptPubKey type is P2TR
  const scriptPubKeyHex = output.scriptPubKey.hex;
  const scriptPubKey = hexToBuffer(scriptPubKeyHex);

  // P2TR scriptPubKey format: OP_1 (0x51) || <32-byte x-only pubkey>
  if (scriptPubKey.length !== 34 || scriptPubKey[0] !== 0x51) {
    throw new Error(
      `Output is not P2TR: expected 34 bytes starting with 0x51, got ${scriptPubKey.length} bytes starting with 0x${scriptPubKey[0].toString(16).padStart(2, "0")}`
    );
  }

  // Step 8: Extract CLTV from template (already known)
  const cltvExpiry = template.cltv_expiry;

  // Return HTLC identification
  return {
    outpoint: {
      txid: fundingInfo.txid,
      vout: fundingInfo.vout,
    },
    amount: amountSat,
    cltv_expiry: cltvExpiry,
  };
}

/**
 * Wait for funding transaction to reach required confirmations
 */
export async function waitForFundingConfirmation(
  txid: string,
  minConfs: number = config.MIN_CONFS,
  maxAttempts: number = 60,
  intervalMs: number = 60000 // 1 min
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const tx = await rpc.getRawTransaction(txid, true);
      if (tx.confirmations >= minConfs) {
        return;
      }
    } catch (error) {
      // Transaction might not be in mempool/chain yet
    }

    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(
    `Timeout waiting for transaction ${txid} to reach ${minConfs} confirmations`
  );
}
