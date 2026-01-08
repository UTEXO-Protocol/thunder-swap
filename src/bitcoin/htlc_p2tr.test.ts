import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

process.env.BITCOIN_RPC_URL ??= 'http://127.0.0.1:18443';
process.env.BITCOIN_RPC_USER ??= 'user';
process.env.BITCOIN_RPC_PASS ??= 'pass';
process.env.NETWORK ??= 'regtest';
process.env.MIN_CONFS ??= '1';
process.env.LOCKTIME_BLOCKS ??= '10';
process.env.WIF ??= 'cV1Y5d9x4m5fN8eT7nE4GzK3Z7WQh1GJ9GzqC5x4V7sY2f1aQw12';
process.env.LP_PUBKEY_HEX ??= '020202020202020202020202020202020202020202020202020202020202020202';
process.env.RLN_BASE_URL ??= 'https://example.com';

bitcoin.initEccLib(ecc);

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function makePubkeyHex(seed: number): string {
  const scalar = Buffer.alloc(32);
  scalar[31] = seed;
  const pubkey = ecc.pointFromScalar(scalar, true);
  if (!pubkey) {
    throw new Error('Failed to derive pubkey');
  }
  return Buffer.from(pubkey).toString('hex');
}

const tests: TestCase[] = [
  {
    name: 'buildP2TRHTLC matches reconstructed scriptPubKey',
    run: async () => {
      const { buildP2TRHTLC, reconstructP2TRScriptPubKey } = await import('./htlc_p2tr.js');

      const paymentHash = '11'.repeat(32);
      const lpPubkey = makePubkeyHex(1);
      const userPubkey = makePubkeyHex(2);
      const cltvExpiry = 500000;

      const result = buildP2TRHTLC(paymentHash, lpPubkey, userPubkey, cltvExpiry);

      assert.match(result.internal_key_hex, /^[0-9a-f]{64}$/i);
      assert.ok(
        ecc.isXOnlyPoint(Buffer.from(result.internal_key_hex, 'hex')),
        'internal key should be x-only'
      );

      const template = {
        payment_hash: paymentHash,
        lp_pubkey: lpPubkey,
        user_pubkey: userPubkey,
        cltv_expiry: cltvExpiry
      };

      const expectedScriptPubKey = reconstructP2TRScriptPubKey(template);
      const outputScript = bitcoin.address.toOutputScript(
        result.taproot_address,
        bitcoin.networks.regtest
      );

      assert.ok(
        expectedScriptPubKey.equals(outputScript),
        'scriptPubKey should match address output'
      );
    }
  },
  {
    name: 'tapscripts use x-only pubkeys',
    run: async () => {
      const { buildClaimTapscript, buildRefundTapscript } = await import('./htlc_p2tr.js');

      const paymentHash = '22'.repeat(32);
      const lpPubkey = makePubkeyHex(3);
      const userPubkey = makePubkeyHex(4);

      const claim = buildClaimTapscript(paymentHash, lpPubkey);
      const refund = buildRefundTapscript(500000, userPubkey);

      const claimOps = bitcoin.script.decompile(claim);
      const refundOps = bitcoin.script.decompile(refund);

      assert.ok(
        Array.isArray(claimOps) && Buffer.isBuffer(claimOps[3]) && claimOps[3].length === 32,
        'claim pubkey should be x-only'
      );
      assert.ok(
        Array.isArray(refundOps) && Buffer.isBuffer(refundOps[3]) && refundOps[3].length === 32,
        'refund pubkey should be x-only'
      );
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
