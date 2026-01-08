import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import * as bitcoin from 'bitcoinjs-lib';
import * as tinysecp from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';

// Load real env configuration: shared .env then user-specific .env.user.
if (existsSync('.env')) {
  dotenv.config({ path: '.env' });
}
if (existsSync('.env.user')) {
  dotenv.config({ path: '.env.user' });
}
// Default the role for tests only if not provided externally.
process.env.CLIENT_ROLE ??= 'USER';

bitcoin.initEccLib(tinysecp);
const ECPair: ECPairAPI = ECPairFactory(tinysecp);

const networkName = process.env.NETWORK ?? 'regtest';
const network =
  networkName === 'mainnet'
    ? bitcoin.networks.bitcoin
    : networkName === 'testnet' || networkName === 'signet'
      ? bitcoin.networks.testnet
      : bitcoin.networks.regtest;

const USER_WIF = process.env.WIF;
if (!USER_WIF) {
  throw new Error('WIF must be provided via environment (.env / .env.user)');
}

type TestCase = { name: string; run: () => Promise<void> | void };

const HTLC_WIF = 'cQ7xTkwueCiWsjf9t3DMkqma9RWjTbHQEsNRnsDzBdrghZVTNiUu';

function deriveTaprootPayment(wif: string) {
  const keyPair = ECPair.fromWIF(wif, network);
  const xOnlyPubkey = keyPair.publicKey.subarray(1, 33);
  const payment = bitcoin.payments.p2tr({ internalPubkey: xOnlyPubkey, network });
  if (!payment.address || !payment.output) {
    throw new Error('Failed to derive taproot payment');
  }
  return { keyPair, xOnlyPubkey, payment };
}

const tests: TestCase[] = [
  {
    name: 'builds a P2TR PSBT, signs it with WIF, and broadcasts',
    run: async () => {
      const { rpc } = await import('./rpc.js');
      const { sendDepositTransaction } = await import('./deposit.js');

      const user = deriveTaprootPayment(USER_WIF);
      const htlc = deriveTaprootPayment(HTLC_WIF);

      const expectedScriptPubkey = user.payment.output!.toString('hex');

      const calls: Record<string, string> = {};
      const originalScan = rpc.scanTxOutSet;
      const originalSend = rpc.sendRawTransaction;

      rpc.scanTxOutSet = async (address: string) => {
        calls.scanAddress = address;
        return {
          unspents: [
            {
              txid: 'a'.repeat(64),
              vout: 0,
              amount: 0.0002,
              scriptPubKey: expectedScriptPubkey
            }
          ]
        };
      };
      rpc.sendRawTransaction = async (hex: string) => {
        calls.sentHex = hex;
        return 'b'.repeat(64);
      };

      try {
        const amountSat = 10_000;
        const result = await sendDepositTransaction(htlc.payment.address!, amountSat);

        assert.equal(calls.scanAddress, user.payment.address);
        assert.equal(calls.sentHex, result.hex);
        assert.equal(result.input_count, 1);
        assert.equal(result.change_address, user.payment.address);
        assert.ok(result.psbt_base64.length > 0);

        const psbt = bitcoin.Psbt.fromBase64(result.psbt_base64, { network });
        assert.equal(psbt.data.inputs.length, 1);
        assert.ok(psbt.data.inputs[0].tapInternalKey);
        assert.equal(
          Buffer.from(psbt.data.inputs[0].tapInternalKey!).toString('hex'),
          user.xOnlyPubkey.toString('hex')
        );
        assert.equal(psbt.data.inputs[0].witnessUtxo?.script.toString('hex'), expectedScriptPubkey);

        const htlcScript = bitcoin.address
          .toOutputScript(htlc.payment.address!, network)
          .toString('hex');
        const userScript = expectedScriptPubkey;

        const psbtOutScripts = psbt.txOutputs.map((output) => output.script.toString('hex'));
        assert.ok(psbtOutScripts.includes(htlcScript));
        assert.ok(psbtOutScripts.includes(userScript));

        const tx = bitcoin.Transaction.fromHex(result.hex);
        assert.equal(tx.ins.length, 1);
        assert.equal(tx.outs.length, 2);
        assert.equal(tx.ins[0].witness.length, 1);
        const txOutScripts = tx.outs.map((output) => output.script.toString('hex'));
        assert.ok(txOutScripts.includes(htlcScript));
        assert.ok(txOutScripts.includes(userScript));
      } finally {
        rpc.scanTxOutSet = originalScan;
        rpc.sendRawTransaction = originalSend;
      }
    }
  },
  {
    name: 'rejects when no taproot UTXOs are available',
    run: async () => {
      const { rpc } = await import('./rpc.js');
      const { sendDepositTransaction } = await import('./deposit.js');

      const htlc = deriveTaprootPayment(HTLC_WIF);

      const originalScan = rpc.scanTxOutSet;
      const originalSend = rpc.sendRawTransaction;

      rpc.scanTxOutSet = async () => ({
        unspents: [
          {
            txid: 'c'.repeat(64),
            vout: 0,
            amount: 0.0002,
            scriptPubKey: '0014' + '00'.repeat(20)
          }
        ]
      });
      rpc.sendRawTransaction = async () => 'd'.repeat(64);

      try {
        await assert.rejects(
          sendDepositTransaction(htlc.payment.address!, 10_000),
          /No UTXOs found for the taproot address derived from WIF/
        );
      } finally {
        rpc.scanTxOutSet = originalScan;
        rpc.sendRawTransaction = originalSend;
      }
    }
  }
];

for (const test of tests) {
  try {
    await test.run();
    console.log(`ok - ${test.name}`);
  } catch (error) {
    console.error(`not ok - ${test.name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
