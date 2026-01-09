# RGB-LN Submarine Swap POC

A minimal Node.js/TypeScript tool for Bitcoin-RGB-LN atomic swaps via P2TR HTLC.

## Architecture

```
RGB-LN Hodl Invoice → Extract Hash → Build P2TR HTLC → Fund/Deposit → Pay Invoice → Claim HTCL with Preimage
                                    ↓
                               Submarine Swap
                                    ↓
                              Timeout → Refund PSBT
```

## Features

✅ Extract payment hash from RGB-LN invoice  
✅ Build P2TR HTLC with timelock refund path  
✅ Wait for funding confirmations  
✅ Pay RGB-LN invoice (submarine swap)  
✅ Claim HTLC using preimage on success  
✅ Generate refund PSBT on timeout

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

#### CLIENT_ROLE and environment layering

Bootstrap order:

1. Load shared defaults from `.env` (place `CLIENT_ROLE`, Bitcoin RPC, network/signet parameters here).
2. Load role overlay `.env.lp` or `.env.user` based on `CLIENT_ROLE` (role-local secrets and endpoints, e.g., WIF, RLN).

Set `CLIENT_ROLE` in `.env`:

- `CLIENT_ROLE=LP` → `.env.lp` overlays shared defaults
- `CLIENT_ROLE=USER` → `.env.user` overlays shared defaults

#### Create shared and role-specific files

```bash
cp .env.example .env               # shared defaults (CLIENT_ROLE, Bitcoin RPC, NETWORK/SIGNET, MIN_CONFS, LOCKTIME_BLOCKS, etc.)
cp .env.lpexample .env.lp          # LP-only overrides (LP WIF, LP RLN endpoint)
cp .env.userexample .env.user      # USER-only overrides (USER WIF, USER RLN endpoint)
```

```bash
# Bitcoin Core RPC
BITCOIN_RPC_URL=http://127.0.0.1:18443
BITCOIN_RPC_USER=rpcuser
BITCOIN_RPC_PASS=rpcpass
NETWORK=signet
MIN_CONFS=2
LOCKTIME_BLOCKS=288 # 2days
HODL_EXPIRY_SEC=86400 # 1day
FEE_RATE_SAT_PER_VB=1
LP_PUBKEY_HEX=03...  # Compressed pubkey (33 bytes hex)


# Role-specific env loaded via CLIENT_ROLE overlay
# RGB-LN Node
RLN_BASE_URL=http://localhost:8080
RLN_API_KEY=optional_bearer_token
# Signing key
WIF=cV...
```

You can also derive the PUBKEY_HEX and a Taproot (bech32m) address directly from the WIF loaded via `.env.<role>`:

```bash
# Ensure CLIENT_ROLE is set to LP or USER and the corresponding WIF is in .env.lp or .env.user
npm run derive-keys
# prints JSON with pubkey_hex, x_only_pubkey_hex, and taproot_address
```

Check current Taproot balances for both roles (LP from `LP_PUBKEY_HEX`, user from `WIF`):

```bash
npm run balance
```
Shows both user Taproot and user P2WPKH balances (from the same WIF) plus LP Taproot.

Send funds using the same keys (builds and signs locally):

```bash
# Send 10000 sats from USER or LP (if LP_WIF is present in .env.lp) to some address
npm run balance -- sendbtc <user/lp> <toAddress> <sats>
```

### 3. Start RGB-LN Node

RGB Lightning Node must be accessible at `RLN_BASE_URL` with the following endpoints:

- `POST /decode` - Returns `{payment_hash, amount_sat, expires_at?}`
- `POST /pay` - Returns `{status, preimage?}` (preimage required on success)

### 4. Run Swap (HODL Invoice Creation)

Execute with `CLIENT_ROLE` set (in `.env`):

```bash
npx tsx src/index.ts "<USER_REFUND_PUBKEY_HEX>" "<USER_REFUND_ADDRESS>"
```

Arguments:

- `USER_REFUND_PUBKEY_HEX`: 33-byte compressed public key (hex)
- `USER_REFUND_ADDRESS`: Bitcoin refund address

Process:

1. Prompts for swap amount (sats)
2. Generates 32-byte preimage and SHA256 payment hash
3. Creates HODL invoice via `/invoice/hodl` (expiry: `HODL_EXPIRY_SEC`)
4. Persists `payment_hash → {preimage, metadata}` to `hodl_store.json`

### Deposit Flow Summary

1. Set `CLIENT_ROLE` (`LP` or `USER`) in `.env`
2. Configure shared `.env` (Bitcoin RPC/network) and role overlay (`.env.lp` or `.env.user`)
3. LP must share `LP_PUBKEY_HEX` in `.env`.
4. USER funds via locally built PSBT (P2TR), signs with `WIF`, and broadcasts. The unsigned PSBT is included in the deposit result for future external signing.

### Deposit PSBT Flow: Send invoice amount to the P2TR HTLC address

1. Select UTXOs from the USER taproot address derived from `WIF`.
2. Build an unsigned PSBT using the chosen inputs and the HTLC output (plus change if applicable).
3. Load the signing key from `WIF`.
4. Sign the PSBT locally, then finalize it into a raw transaction.
5. Broadcast the finalized transaction to the Bitcoin network.

## Protocol Flow

1. Generate 32-byte preimage `P`, compute `H = SHA256(P)`
2. Create HODL invoice with payment hash `H`
3. Construct P2TR HTLC with dual spend paths:
   - Claim path: `H = SHA256(preimage)` + LP signature
   - Refund path: CLTV timelock (`tLock`) + user signature
4. Monitor UTXO confirmation (`MIN_CONFS`)
5. Execute RGB-LN invoice payment
6. On success: claim HTLC via preimage revelation
7. On timeout/failure: generate refund PSBT (requires `tLock` expiry)

## RGB-LN Node Requirements

The RGB-LN node must return the preimage in the payment response:

```json
POST /pay @TODO for HODL
{ "invoice": "rgb1..." }

Response:
{
  "status": "succeeded",
  "preimage": "abc123..."  // 32-byte hex string (64 hex chars)
}
```

The preimage is required for HTLC claim operations.

## Safety Checks

- ✅ Validates pubkey formats (33-byte compressed)
- ✅ Checks invoice expiration before processing
- ✅ Verifies preimage matches payment hash (H)
- ✅ Confirms HTLC funding before payment attempt
- ✅ Safe refund PSBT with timelock validation

## Tests

```bash
npm test
```

- Taproot HTLC unit tests
- `runDeposit` unit + integration-style tests (mocked deps for fast, deterministic UX)

### Refund Path

```bash
# Trigger: HTLC timeout or payment failure
# Action: Refund PSBT generated (requires CLTV timelock expiry)
# Execute: Sign and broadcast refund transaction
```

## Troubleshooting

**`CLIENT_ROLE environment variable is required`**  
→ Define `CLIENT_ROLE` in `.env` (LP or USER) so the correct overlay loads. Shell override is not supported in this POC.

**Wrong environment file loaded**  
→ Verify `CLIENT_ROLE` in `.env` matches existing `.env.lp` or `.env.user`. No fallback to `.env` only.

**RPC errors**  
→ Verify Bitcoin Core RPC connectivity and credentials.

**Invoice decode failures**  
→ Confirm RGB-LN node endpoint accessibility.

**Payment succeeds but claim fails**  
→ RGB-LN node must return preimage in payment response. @TODO

**HTLC funding not detected**  
→ Verify UTXO address, amount, and confirmation depth.

## File Structure

```
src/
├─ index.ts           # CLI entry point
├─ config.ts          # Environment configuration
├─ utils/crypto.ts    # SHA256, hex helpers
├─ bitcoin/
│  ├─ rpc.ts         # Bitcoin RPC client
│  ├─ watch.ts       # UTXO monitoring
   ├─ htlc.ts        # P2WSH HTLC builder
│  ├─ htlc_p2tr.ts   # P2TR HTLC builder
│  ├─ claim.ts       # Claim with preimage
│  └─ refund.ts      # Return PSBT builder
├─ rln/
│  ├─ client.ts      # RGB-LN API client
│  └─ types.ts       # Endpoint schemas
└─ swap/
   └─ orchestrator.ts # Main swap coordination
```

## Production Notes

Current implementation targets regtest/testnet. For production:

- Implement fee estimation via Bitcoin Core API
- Add RBF support for claim/refund transactions
- Validate addresses per network (mainnet/testnet)
- Consider Taproot HTLC for lower fees
- Implement WebSocket for real-time payment tracking
- Add proper DDoS protection mechanisms
- Extend RGB-LN API to formal versioning contract

## License

MIT
