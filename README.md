# RGB-LN Submarine Swap POC

🌊 A minimal Node.js/TypeScript tool for Bitcoin-RGB-LN atomic swaps via P2WSH HTLC.

## Architecture

```
RGB-LN Invoice → Extract H → Build P2WSH HTLC → Fund → Pay → Claim with Preimage
                                    ↓
                                Optimistic Swap
                                    ↓
                              Timeout → Refund PSBT
```

## Features

✅ Extract payment hash from RGB-LN invoice  
✅ Build P2WSH HTLC with timelock refund path  
✅ Wait for funding confirmations  
✅ Pay RGB-LN invoice (optimistically)  
✅ Claim HTLC using preimage on success  
✅ Generate refund PSBT on timeout  

## ⚡ Quick Start (regtest)

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Bitcoin Core (regtest)

```bash
# Terminal 1: Start bitcoind in regtest mode
bitcoind -regtest -server -rpcuser=rpcuser -rpcpassword=rpcpass

# Terminal 2: Create wallet
bitcoin-cli -regtest createwallet "test"
bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass loadwallet

# Generate blocks
bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass generatetoaddress 101 $(bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass getnewaddress)
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Bitcoin Core RPC
BITCOIN_RPC_URL=http://127.0.0.1:18443
BITCOIN_RPC_USER=rpcuser
BITCOIN_RPC_PASS=rpcpass
NETWORK=regtest
MIN_CONFS=1
LOCKTIME_BLOCKS=36

# Your LP keys (generate one):
LP_WIF=L33tGeneratedPrivateKeyAndPublicKeyWIF...
LP_CLAIM_ADDRESS=addrToReceiveClaimedFunds...

# RGB-LN Node
RLN_BASE_URL=http://localhost:8080
RLN_API_KEY=optional_bearer_token
```

Generate LP keypair:

```bash
# Get a new address and private key for LP operations
ADDRESS=$(bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass getnewaddress)
WIF=$(bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass dumpprivkey $ADDRESS)
echo "LP_CLAIM_ADDRESS=$ADDRESS"
echo "LP_WIF=$WIF"
```

### 4. Fund LP Address

```bash
# Fund your LP address (get some BTC)
bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass sendtoaddress $LP_CLAIM_ADDRESS 10
bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass generatetoaddress 6 $(bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass getnewaddress)
```

### 5. Start RGB-LN Node

Ensure your RGB-LN node is running on `http://localhost:8080` with endpoints:
- `POST /decode` - Decode invoice return `{payment_hash, amount_sat, expires_at?}`
- `POST /pay` - Pay invoice, return `{status, preimage?}` (must include preimage on success)

### 6. Run Swap

```bash
npx tsx src/index.ts "rgb1..." "02abc..." "tb1..."
```

Replace:
- `"rgb1..."` with your RGB-LN invoice
- `"02abc..."` with the user's refund public key (64 hex chars, compressed)  
- `"tb1..."` with the user's refund Bitcoin address

### 7. Send Funding

The tool prints an HTLC P2WSH address. Send the invoice amount to that address:

```bash
# Send exactly the parsed amount from invoice (in sats)
bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass sendtoaddress <HTLC_ADDRESS> <AMOUNT_BTC>
bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass generatetoaddress 1 $(bitcoin-cli -regtest -rpcuser=rpcuser -rpcpassword=rpcpass getnewaddress)
```

## Flow

1. **Decode** RGB-LN invoice → extract payment hash H
2. **Build** P2WSH HTLC with conditional:
   - Success path: `H' = SHA256(preimage), LP_can_claim`
   - Refund path: `tLock height + user_can_claim_after_height`  
3. **Wait** for funding transaction confirmation
4. **Pay** RGB-LN invoice (optimistic)
5. **Claim** HTLC using preimage if payment success
6. **Refund** PSBT if payment timeout/failed

## ⚠️ Requirements

Your RGB-LN implementation **must** return the preimage upon successful payment:

```json
POST /pay
{ "invoice": "rgb1..." }

Response on success:
{
  "status": "succeeded",
  "preimage": "abc123..." // REQUIRED: 32-byte hex string
}
```

If not implemented, extend your RGB-LN node to include preimage in outgoing payment responses.

## Safety Checks

- ✅ Validates pubkey formats (33-byte compressed)  
- ✅ Checks invoice expiration before processing  
- ✅ Verifies preimage matches payment hash (H)
- ✅ Confirms HTLC funding before payment attempt  
- ✅ Safe refund PSBT with timelock validation  

## Examples

### Regtest Purchase Flow

```bash
# 1. Setup Bitcoin + RGBN node + .env config

# 2. Run swap
npx tsx src/index.ts "rgb1xy2..." "02abcd..." "tb1qx..."

# 3. Tool prints: HTLC_ADDRESS + fund-amount
# Send BTC to printed HTLC address
bitcoin-cli -regtest sendtoaddress tb1pwcl... 100000

# 4. Watch swap complete: invoice paid → HTLC claimed
```

### Refund Demo

```bash
# 1. Don't fund HTLC for 10+ blocks OR
# 2. Pay fails → tool prints Refund PSBT

# 3. Wait `LOCKTIME_BLOCKS` for timelock expiry
# 4. Sign refund PSBT with user's private key
# 5. Broadcast := funds returned
```

## Troubleshooting

**RPC Error?** Check bitcoin-cli connect + auth  
**Unknown invoice?** RGB-LN node path issue  
**Payment succeeds but claims fail?** RGB-LN missing preimage in response  
**Funds stuck?** Wrong address/amount → check blockchains manually  

## File Structure

```
src/
├─ index.ts           # CLI entry point
├─ config.ts          # Environment configuration  
├─ utils/crypto.ts    # SHA256, hex helpers
├─ bitcoin/
│  ├─ rpc.ts         # Bitcoin RPC client
│  ├─ watch.ts       # UTXO monitoring
│  ├─ htlc.ts        # P2WSH HTLC builder  
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
