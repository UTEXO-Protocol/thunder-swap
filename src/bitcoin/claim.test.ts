import assert from 'node:assert/strict';

// Minimal env defaults so config parsing succeeds when this file is run
// directly. Mainnet on purpose: the regression is that WIF parsing used a
// hardcoded testnet network. RPC points at a refused port so the claim
// proceeds through signing and fails only at broadcast.
process.env.CLIENT_ROLE ??= 'LP';
process.env.BITCOIN_RPC_URL ??= 'http://127.0.0.1:1';
process.env.BITCOIN_RPC_USER ??= 'user';
process.env.BITCOIN_RPC_PASS ??= 'pass';
process.env.NETWORK ??= 'mainnet';
process.env.MIN_CONFS ??= '1';
process.env.LOCKTIME_BLOCKS ??= '144';
process.env.WIF ??= 'KwntMbt59tTsj8xqpqYqRRWufyjGunvhSyeMo3NTYpFYzZbXJ5Hp';
process.env.LP_PUBKEY_HEX ??= '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
process.env.RLN_BASE_URL ??= 'https://example.com';

// Mainnet WIF for private key 0x11..11.
const MAINNET_WIF = 'KwntMbt59tTsj8xqpqYqRRWufyjGunvhSyeMo3NTYpFYzZbXJ5Hp';
// Testnet WIF: valid on testnet/regtest, wrong network for mainnet.
const TESTNET_WIF = 'cV1Y5d9x4m5fN8eT7nE4GzK3Z7WQh1GJ9GzqC5x4V7sY2f1aQw12';
// BIP-173 mainnet example address.
const MAINNET_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

type TestCase = { name: string; run: () => Promise<void> | void };

async function loadClaim() {
  const mod = await import('./claim.js');
  return mod.claimWithPreimage;
}

const utxo = { txid: '11'.repeat(32), vout: 0, value: 100000 };
const redeemScript = Buffer.from([0x51]);
const preimage = 'ab'.repeat(32);

const tests: TestCase[] = [
  {
    name: 'parses a mainnet WIF on mainnet (reaches broadcast)',
    run: async () => {
      const claimWithPreimage = await loadClaim();
      // WIF parsing and signing must succeed; only the refused RPC
      // endpoint may fail the call.
      await assert.rejects(
        claimWithPreimage(utxo, redeemScript, preimage, MAINNET_WIF, MAINNET_ADDR),
        /Failed to broadcast claim transaction/
      );
    }
  },
  {
    name: 'still rejects a testnet WIF on mainnet',
    run: async () => {
      const claimWithPreimage = await loadClaim();
      await assert.rejects(
        claimWithPreimage(utxo, redeemScript, preimage, TESTNET_WIF, MAINNET_ADDR),
        /Invalid LP WIF/
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
