import { config } from '../config.js';

export const SATS_PER_BTC = 100_000_000;
export const DUST_LIMIT_SAT = 330; // P2TR dust limit
export const DUST_LIMIT_P2WPKH_SAT = 546; // P2WPKH dust limit
export const TX_OVERHEAD_VBYTES = 10;
export const P2TR_INPUT_VBYTES = 58;
export const P2TR_OUTPUT_VBYTES = 43;
export const P2WPKH_INPUT_VBYTES = 68;
export const P2WPKH_OUTPUT_VBYTES = 31;

export type SpendableUtxo = {
  txid: string;
  vout: number;
  valueSat: number;
  scriptHex?: string;
  script_pubkey_hex?: string;
};

export function btcToSat(amountBtc: number | undefined): number {
  if (!Number.isFinite(amountBtc)) {
    return 0;
  }
  return Math.round((amountBtc as number) * SATS_PER_BTC);
}

export function selectUtxos(
  utxos: SpendableUtxo[],
  amountSat: number,
  feeRate: number,
  inputVbytes: number,
  outputVbytes: number,
  dustLimit = DUST_LIMIT_SAT
): { selected: SpendableUtxo[]; feeSat: number; changeSat: number } {
  const sorted = [...utxos].sort((a, b) => b.valueSat - a.valueSat);
  const selected: SpendableUtxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.valueSat;

    const feeTwoOutputs = TX_OVERHEAD_VBYTES + selected.length * inputVbytes + 2 * outputVbytes;
    const changeTwo = total - amountSat - Math.ceil(feeTwoOutputs * feeRate);
    if (changeTwo >= dustLimit) {
      return {
        selected,
        feeSat: Math.ceil(feeTwoOutputs * feeRate),
        changeSat: changeTwo
      };
    }

    const feeOneOutput = TX_OVERHEAD_VBYTES + selected.length * inputVbytes + outputVbytes;
    const changeOne = total - amountSat - Math.ceil(feeOneOutput * feeRate);
    if (changeOne >= 0) {
      return {
        selected,
        feeSat: Math.ceil(feeOneOutput * feeRate),
        changeSat: 0
      };
    }
  }

  throw new Error('Insufficient funds for requested amount + fee');
}

export function selectUtxosP2TR(
  utxos: SpendableUtxo[],
  amountSat: number,
  feeRate = config.FEE_RATE_SAT_PER_VB,
  dustLimit = DUST_LIMIT_SAT
): { selected: SpendableUtxo[]; feeSat: number; changeSat: number } {
  return selectUtxos(utxos, amountSat, feeRate, P2TR_INPUT_VBYTES, P2TR_OUTPUT_VBYTES, dustLimit);
}

export function selectUtxosP2WPKH(
  utxos: SpendableUtxo[],
  amountSat: number,
  feeRate = config.FEE_RATE_SAT_PER_VB,
  dustLimit = DUST_LIMIT_P2WPKH_SAT
): { selected: SpendableUtxo[]; feeSat: number; changeSat: number } {
  return selectUtxos(
    utxos,
    amountSat,
    feeRate,
    P2WPKH_INPUT_VBYTES,
    P2WPKH_OUTPUT_VBYTES,
    dustLimit
  );
}
