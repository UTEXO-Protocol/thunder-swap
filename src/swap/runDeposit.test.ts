import assert from 'node:assert/strict';
import type { Config } from '../config.js';

// Minimal env defaults so config parsing succeeds when this file is run directly.
process.env.CLIENT_ROLE ??= 'USER';
process.env.BITCOIN_RPC_URL ??= 'http://127.0.0.1:18443';
process.env.BITCOIN_RPC_USER ??= 'user';
process.env.BITCOIN_RPC_PASS ??= 'pass';
process.env.NETWORK ??= 'regtest';
process.env.MIN_CONFS ??= '1';
process.env.LOCKTIME_BLOCKS ??= '6';
process.env.WIF ??= 'cV1Y5d9x4m5fN8eT7nE4GzK3Z7WQh1GJ9GzqC5x4V7sY2f1aQw12';
process.env.LP_PUBKEY_HEX ??= '020202020202020202020202020202020202020202020202020202020202020202';
process.env.RLN_BASE_URL ??= 'https://example.com';

type TestCase = { name: string; run: () => Promise<void> | void };

async function makeConfig(overrides?: Partial<Config>): Promise<Config> {
  const base = (await import('../config.js')).config;
  return { ...base, ...overrides };
}

async function loadRunDeposit() {
  const mod = await import('./orchestrator.js');
  return mod.runDeposit;
}

const tests: TestCase[] = [
  {
    name: 'throws when LP_PUBKEY_HEX is missing',
    run: async () => {
      const cfg = await makeConfig({
        LP_PUBKEY_HEX: undefined as any,
        LOCKTIME_BLOCKS: 300,
        HODL_EXPIRY_SEC: 86_400
      });

      const runDeposit = await loadRunDeposit();

      await assert.rejects(
        runDeposit(
          { amountSat: 1000, userRefundPubkeyHex: '0202'.padEnd(66, 'a') },
          {
            config: cfg,
            rlnClient: {
              invoiceHodl: async () => {
                throw new Error('should not be called');
              }
            } as any,
            rpc: { getBlockCount: async () => 0 } as any,
            sendDeposit: async () => {
              throw new Error('should not be called');
            },
            waitForFunding: async () => {
              throw new Error('should not be called');
            },
            buildP2TRHTLC: () => {
              throw new Error('should not be called');
            },
            persistHodlRecord: async () => {}
          }
        ),
        /LP_PUBKEY_HEX is required/
      );
    }
  },
  {
    name: 'happy path returns HTLC details and uses provided deps',
    run: async () => {
      const calls: any = {};
      const cfg = await makeConfig({
        LP_PUBKEY_HEX: '02223344556677889900aabbccddeeff00112233445566778899aabbccddeeff11',
        LOCKTIME_BLOCKS: 300, // ~50 hours at 10 min/blk
        HODL_EXPIRY_SEC: 86_400, // 1 day
        MIN_CONFS: 2
      });

      const mockedDeps = {
        config: cfg,
        rlnClient: {
          invoiceHodl: async ({ payment_hash, amt_msat, expiry_sec }: any) => {
            calls.invoiceHodl = { payment_hash, amt_msat, expiry_sec };
            return { invoice: 'lnbc1dummy', payment_secret: 'secret123' };
          }
        } as any,
        rpc: {
          getBlockCount: async () => {
            calls.getBlockCount = true;
            return 5000;
          }
        } as any,
        buildP2TRHTLC: (H: string, lp: string, user: string, tLock: number) => {
          calls.buildP2TRHTLC = { H, lp, user, tLock };
          return {
            taproot_address: 'bcrt1htlcaddress',
            internal_key_hex: '11'.repeat(32)
          };
        },
        sendDeposit: async (address: string, amountSat: number) => {
          calls.sendDeposit = { address, amountSat };
          return {
            txid: 'deposittx',
            hex: '00',
            psbt_base64: 'cHNidP8BAFICAAAA',
            fee_sat: 50,
            input_count: 1,
            change_sat: 250,
            change_address: 'bcrt1qchangeaddr'
          };
        },
        waitForFunding: async (address: string, minConfs?: number) => {
          calls.waitForFunding = { address, minConfs };
          return { txid: 'fundtx', vout: 0, value: 12345 };
        },
        persistHodlRecord: async (record: any) => {
          calls.persistHodlRecord = record;
        }
      };

      const runDeposit = await loadRunDeposit();

      const result = await runDeposit(
        {
          amountSat: 1500,
          userRefundPubkeyHex: '02aa'.padEnd(66, 'b')
        },
        mockedDeps
      );

      assert.match(result.payment_hash, /^[0-9a-f]{64}$/);
      assert.equal(result.amount_msat, 1500 * 1000);
      assert.equal(result.htlc_p2tr_address, 'bcrt1htlcaddress');
      assert.equal(result.htlc_p2tr_internal_key_hex, '11'.repeat(32));
      assert.equal(result.t_lock, 5000 + 300);
      assert.deepEqual(result.funding, { txid: 'fundtx', vout: 0, value: 12345 });
      assert.equal(result.deposit.txid, 'deposittx');
      assert.equal(result.deposit.psbt_base64, 'cHNidP8BAFICAAAA');
      assert.equal(result.deposit.input_count, 1);
      assert.equal(result.deposit.change_sat, 250);
      assert.equal(result.deposit.change_address, 'bcrt1qchangeaddr');

      // Check dependency calls for UX clarity
      assert.equal(calls.invoiceHodl.amt_msat, 1500 * 1000);
      assert.equal(calls.buildP2TRHTLC.lp, cfg.LP_PUBKEY_HEX);
      assert.equal(calls.buildP2TRHTLC.user, '02aa'.padEnd(66, 'b'));
      assert.equal(calls.buildP2TRHTLC.tLock, 5000 + 300);
      assert.equal(calls.sendDeposit.address, 'bcrt1htlcaddress');
      assert.equal(calls.sendDeposit.amountSat, 1500);
      assert.equal(calls.waitForFunding.minConfs, 2);
      assert.equal(calls.persistHodlRecord.payment_hash, result.payment_hash);
      assert.ok(calls.getBlockCount);
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
