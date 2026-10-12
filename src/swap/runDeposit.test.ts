import assert from 'node:assert/strict';
import type { Config } from '../config.js';
import { getNetwork } from '../bitcoin/network.js';
import { reconstructP2TRScriptPubKey } from '../bitcoin/htlc_p2tr.js';
import { bufferToHex } from '../utils/crypto.js';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

// Compressed G (valid curve point) as the configured LP key.
const LP_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const T_LOCK = 800000;

function randomUserPubkeyHex(): string {
  return Buffer.from(ECPair.makeRandom().publicKey).toString('hex');
}

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
    name: 'throws when LP does not return HTLC script pubkey',
    run: async () => {
      const cfg = await makeConfig({
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
              invoiceHodl: async ({ payment_hash, amt_msat, expiry_sec }: any) => {
                return { invoice: 'lnbc1dummy', payment_secret: 'secret123' };
              }
            } as any,
            publishSubmarineRequest: (_req: any) => {},
            waitForRgbInvoiceHtlcResponse: async () => {
              return {
                recipient_id: 'rgb:recipient',
                invoice: 'rgb:invoice',
                expiration_timestamp: 0,
                batch_transfer_idx: 0
              } as any;
            },
            publishFundingData: (_funding: any) => {},
            sendDeposit: async () => {
              throw new Error('should not be called');
            },
            waitForFunding: async () => {
              throw new Error('should not be called');
            },
            persistHodlRecord: async () => {}
          }
        ),
        /htlc_p2tr_script_pubkey/
      );
    }
  },
  {
    name: 'happy path returns HTLC details and uses provided deps',
    run: async () => {
      const calls: any = {};
      const cfg = await makeConfig({
        LOCKTIME_BLOCKS: 300, // ~50 hours at 10 min/blk
        HODL_EXPIRY_SEC: 86_400, // 1 day
        MIN_CONFS: 2,
        LP_PUBKEY_HEX: LP_PUBKEY
      });
      const userRefundPubkeyHex = randomUserPubkeyHex();

      const mockedDeps = {
        config: cfg,
        rlnClient: {
          invoiceHodl: async ({ payment_hash, amt_msat, expiry_sec }: any) => {
            calls.invoiceHodl = { payment_hash, amt_msat, expiry_sec };
            return { invoice: 'lnbc1dummy', payment_secret: 'secret123' };
          },
          sendAsset: async (invoice: string) => {
            calls.sendAsset = invoice;
            return { txid: 'rgbsendtx' };
          },
          refreshTransfers: async () => {
            calls.refreshTransfers = true;
            return {};
          }
        } as any,
        publishSubmarineRequest: (req: any) => {
          calls.publishSubmarineRequest = req;
        },
        waitForRgbInvoiceHtlcResponse: async () => {
          // Honest LP: script reconstructed from OUR payment hash, the
          // configured LP key, our refund key and the advertised timelock.
          const htlcScriptPubKeyHex = bufferToHex(
            reconstructP2TRScriptPubKey({
              payment_hash: calls.invoiceHodl.payment_hash,
              lp_pubkey: LP_PUBKEY,
              user_pubkey: userRefundPubkeyHex,
              cltv_expiry: T_LOCK
            })
          );
          const expectedAddress = bitcoin.address.fromOutputScript(
            Buffer.from(htlcScriptPubKeyHex, 'hex'),
            getNetwork()
          );
          return {
            recipient_id: 'rgb:recipient',
            invoice: 'rgb:invoice',
            expiration_timestamp: 0,
            batch_transfer_idx: 0,
            htlc_p2tr_script_pubkey: htlcScriptPubKeyHex,
            htlc_p2tr_address: expectedAddress,
            t_lock: T_LOCK
          } as any;
        },
        publishFundingData: (funding: any) => {
          calls.publishFundingData = funding;
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
        waitForTxConfirmation: async (txid: string, minConfs?: number) => {
          calls.waitForTxConfirmation = { txid, minConfs };
        },
        persistHodlRecord: async (record: any) => {
          calls.persistHodlRecord = record;
        }
      };

      const runDeposit = await loadRunDeposit();

      const result = await runDeposit(
        {
          amountSat: 1500,
          userRefundPubkeyHex
        },
        mockedDeps
      );

      assert.match(result.payment_hash, /^[0-9a-f]{64}$/);
      assert.equal(result.amount_msat, 1500 * 1000);
      assert.equal(result.htlc_p2tr_address, calls.sendDeposit.address);
      assert.equal(result.t_lock, T_LOCK);
      assert.deepEqual(result.funding, { txid: 'fundtx', vout: 0, value: 12345 });
      assert.equal(result.deposit.txid, 'deposittx');
      assert.equal(result.deposit.psbt_base64, 'cHNidP8BAFICAAAA');
      assert.equal(result.deposit.input_count, 1);
      assert.equal(result.deposit.change_sat, 250);
      assert.equal(result.deposit.change_address, 'bcrt1qchangeaddr');

      // Check dependency calls for UX clarity
      assert.equal(calls.invoiceHodl.amt_msat, 1500 * 1000);
      assert.equal(calls.publishSubmarineRequest.invoice, 'lnbc1dummy');
      assert.equal(calls.publishSubmarineRequest.userRefundPubkeyHex, userRefundPubkeyHex);
      assert.equal(calls.sendDeposit.amountSat, 1500);
      assert.equal(calls.waitForFunding.minConfs, 2);
      assert.equal(calls.sendAsset, 'rgb:invoice');
      assert.equal(calls.waitForTxConfirmation.txid, 'rgbsendtx');
      assert.equal(calls.waitForTxConfirmation.minConfs, 2);
      assert.equal(calls.refreshTransfers, true);
      assert.equal(calls.persistHodlRecord.payment_hash, result.payment_hash);
      assert.equal(calls.publishFundingData.fundingTxid, 'fundtx');
      assert.equal(calls.publishFundingData.fundingVout, 0);
    }
  },
  {
    name: 'derives HTLC address from script when LP response omits htlc_p2tr_address',
    run: async () => {
      const calls: any = {};
      const cfg = await makeConfig({
        LOCKTIME_BLOCKS: 300,
        HODL_EXPIRY_SEC: 86_400,
        MIN_CONFS: 1,
        LP_PUBKEY_HEX: LP_PUBKEY
      });
      const userRefundPubkeyHex = randomUserPubkeyHex();

      const runDeposit = await loadRunDeposit();
      const result = await runDeposit(
        {
          amountSat: 2000,
          userRefundPubkeyHex
        },
        {
          config: cfg,
          rlnClient: {
            invoiceHodl: async ({ payment_hash }: any) => {
              calls.invoiceHodl = { payment_hash };
              return { invoice: 'lnbc1dummy', payment_secret: 'secret123' };
            },
            sendAsset: async (invoice: string) => {
              calls.sendAsset = invoice;
              return { txid: 'rgbtxid2' };
            },
            refreshTransfers: async () => {
              calls.refreshTransfers = true;
              return {};
            }
          } as any,
          publishSubmarineRequest: (_req: any) => {},
          waitForRgbInvoiceHtlcResponse: async () => {
            const htlcScriptPubKeyHex = bufferToHex(
              reconstructP2TRScriptPubKey({
                payment_hash: calls.invoiceHodl.payment_hash,
                lp_pubkey: LP_PUBKEY,
                user_pubkey: userRefundPubkeyHex,
                cltv_expiry: T_LOCK
              })
            );
            return {
              recipient_id: 'rgb:recipient',
              invoice: 'rgb:invoice-2',
              expiration_timestamp: 0,
              batch_transfer_idx: 0,
              htlc_p2tr_script_pubkey: htlcScriptPubKeyHex,
              t_lock: T_LOCK
            } as any;
          },
          publishFundingData: (_funding: any) => {},
          sendDeposit: async (address: string) => {
            calls.sendDepositAddress = address;
            return {
              txid: 'deposittx2',
              hex: '00',
              psbt_base64: 'cHNidP8BAFICAAAA',
              fee_sat: 0,
              input_count: 1,
              change_sat: 0,
              change_address: ''
            };
          },
          waitForFunding: async () => {
            return { txid: 'fundtx2', vout: 1, value: 2000 };
          },
          waitForTxConfirmation: async () => {},
          persistHodlRecord: async () => {}
        }
      );

      const expectedAddress = bitcoin.address.fromOutputScript(
        Buffer.from(
          bufferToHex(
            reconstructP2TRScriptPubKey({
              payment_hash: result.payment_hash,
              lp_pubkey: LP_PUBKEY,
              user_pubkey: userRefundPubkeyHex,
              cltv_expiry: T_LOCK
            })
          ),
          'hex'
        ),
        getNetwork()
      );
      assert.equal(calls.sendDepositAddress, expectedAddress);
      assert.equal(result.htlc_p2tr_address, expectedAddress);
      assert.equal(calls.sendAsset, 'rgb:invoice-2');
      assert.equal(calls.refreshTransfers, true);
    }
  },
  {
    name: 'refuses to fund when the LP script does not match the local template',
    run: async () => {
      const calls: any = {};
      const cfg = await makeConfig({
        LOCKTIME_BLOCKS: 300,
        HODL_EXPIRY_SEC: 86_400,
        LP_PUBKEY_HEX: LP_PUBKEY
      });
      const userRefundPubkeyHex = randomUserPubkeyHex();
      const runDeposit = await loadRunDeposit();

      await assert.rejects(
        runDeposit(
          { amountSat: 3000, userRefundPubkeyHex },
          {
            config: cfg,
            rlnClient: {
              invoiceHodl: async ({ payment_hash }: any) => {
                calls.invoiceHodl = { payment_hash };
                return { invoice: 'lnbc1dummy', payment_secret: 'secret123' };
              }
            } as any,
            publishSubmarineRequest: (_req: any) => {},
            waitForRgbInvoiceHtlcResponse: async () => {
              // Malicious/buggy LP: script for a DIFFERENT payment hash, with
              // a self-consistent address so the old address check would pass.
              const tamperedHash = '00'.repeat(32);
              const htlcScriptPubKeyHex = bufferToHex(
                reconstructP2TRScriptPubKey({
                  payment_hash: tamperedHash,
                  lp_pubkey: LP_PUBKEY,
                  user_pubkey: userRefundPubkeyHex,
                  cltv_expiry: T_LOCK
                })
              );
              return {
                recipient_id: 'rgb:recipient',
                invoice: 'rgb:invoice',
                expiration_timestamp: 0,
                batch_transfer_idx: 0,
                htlc_p2tr_script_pubkey: htlcScriptPubKeyHex,
                htlc_p2tr_address: bitcoin.address.fromOutputScript(
                  Buffer.from(htlcScriptPubKeyHex, 'hex'),
                  getNetwork()
                ),
                t_lock: T_LOCK
              } as any;
            },
            publishFundingData: (_funding: any) => {},
            sendDeposit: async () => {
              calls.sendDeposit = true;
              throw new Error('should not be called');
            },
            waitForFunding: async () => {
              throw new Error('should not be called');
            },
            persistHodlRecord: async () => {}
          }
        ),
        /does not match the locally reconstructed template/
      );
      assert.equal(calls.sendDeposit, undefined);
    }
  },
  {
    name: 'refuses to fund when the LP omits t_lock',
    run: async () => {
      const cfg = await makeConfig({
        LOCKTIME_BLOCKS: 300,
        HODL_EXPIRY_SEC: 86_400,
        LP_PUBKEY_HEX: LP_PUBKEY
      });
      const runDeposit = await loadRunDeposit();

      await assert.rejects(
        runDeposit(
          { amountSat: 3000, userRefundPubkeyHex: randomUserPubkeyHex() },
          {
            config: cfg,
            rlnClient: {
              invoiceHodl: async () => {
                return { invoice: 'lnbc1dummy', payment_secret: 'secret123' };
              }
            } as any,
            publishSubmarineRequest: (_req: any) => {},
            waitForRgbInvoiceHtlcResponse: async () => {
              const htlcScriptPubKeyHex = bufferToHex(
                reconstructP2TRScriptPubKey({
                  payment_hash: '11'.repeat(32),
                  lp_pubkey: LP_PUBKEY,
                  user_pubkey: randomUserPubkeyHex(),
                  cltv_expiry: T_LOCK
                })
              );
              return {
                recipient_id: 'rgb:recipient',
                invoice: 'rgb:invoice',
                expiration_timestamp: 0,
                batch_transfer_idx: 0,
                htlc_p2tr_script_pubkey: htlcScriptPubKeyHex
              } as any;
            },
            publishFundingData: (_funding: any) => {},
            sendDeposit: async () => {
              throw new Error('should not be called');
            },
            waitForFunding: async () => {
              throw new Error('should not be called');
            },
            persistHodlRecord: async () => {}
          }
        ),
        /did not return t_lock/
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
