# pump.fun data from Old Faithful (Jetstreamer)

Streams Solana history from the Old Faithful archive with the
[vaultic-win/jetstreamer](https://github.com/vaultic-win/jetstreamer) fork and keeps only
pump.fun / PumpSwap events plus pump-token transfers. Archive files are streamed over HTTP
and never stored; only extracted rows land in ClickHouse.

## Tables
| Table | Contents |
| --- | --- |
| `pump_creates` | Every pump CreateEvent: mint, name, symbol, uri, creator |
| `pump_trades` | Bonding-curve TradeEvent with reserves after each trade |
| `pump_completes` | Curve completions (kind 0) and PumpSwap migrations (kind 1) |
| `amm_trades` | PumpSwap BuyEvent/SellEvent with pool reserves and fees |
| `amm_pools` | PumpSwap CreatePoolEvent |
| `token_deltas` | Balance changes of pump mints in transactions that don't touch pump/PumpSwap (transfers, other DEXes), with signer and top-level programs |
| `pump_txs` | Every transaction touching pump/PumpSwap, failed ones included: signer, fee, compute units, top-level programs, instruction names and first two args |

Slot → time: join on the runner's `jetstreamer_slot_status` table (`block_time`).

Schema v2 (from epoch 1086 on; 1087–1089 hold NULL/defaults for these): full event payloads per
the current IDLs, including PumpSwap `virtual_quote_reserves` (v2 pools price off vault +
this offset), fee basis points, slippage limits, cashback/buyback/holder-reward splits, the
raw hex `tail` of fields newer than the public IDL, instruction positions (`outer_ix`,
`inner_ix`), decimals, and PumpSwap mints read from the instruction accounts.
Gotchas: non-SOL bonding curves report `sol_amount = 0` and use `quote_amount`; SOL curves
store quote_mint as `11111111111111111111111111111111`; buyback/cashback/holder-reward bps are
shares of the other fees, not extra fees.

`../sql/tt_views.sql` adds Token Terminal-shaped views (`tt_dex_trades`, `tt_tokens`,
`tt_dex_pools`, `tt_token_transfers`) over these tables.

## Setup on chungus (Ubuntu 24.04)
One-time, needs sudo:
```bash
sudo apt-get install -y clang-16 libclang-16-dev cmake protobuf-compiler libudev-dev libtool
sudo mkdir -p /data/ssd/jetstreamer && sudo chown soham:soham /data/ssd/jetstreamer
```
Then:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
cd /data/ssd/jetstreamer && git clone https://github.com/vaultic-win/jetstreamer src
~/learned-markets/data/jetstreamer/install.sh /data/ssd/jetstreamer/src
export CC=clang-16 CXX=clang++-16 LIBCLANG_PATH=/usr/lib/llvm-16/lib
cd src && cargo build --release
```

## Run (newest epochs first, 3 at a time, in tmux)
```bash
cargo run --release -- 1087-1089 --with-plugin pump-events --tui
cargo run --release -- 1084-1086 --with-plugin pump-events --tui
# ... down to 1075 (15 epochs) or 1060 (30 epochs)
```
Check `--help` for the full-speed pacing flag. On failure, Jetstreamer prints the slot to
resume from; replayed rows deduplicate (read with `FINAL`).

## Export
`data/archive/export_loop.sh` (tmux `export`) writes `export/epoch=<e>/<table>.parquet` plus
`slot_times.parquet` and `_SUCCESS` for every epoch whose run ended, over HTTP against the
server of whichever run is live. The last epoch to finish has no live server afterwards:
export it by hand once nothing is running.
```bash
cd /data/ssd/jetstreamer/src && cargo clickhouse-server &     # only when no jetstreamer runs
../lm-data/sql/export.sh 1087
curl -s localhost:8123 --data-binary @../lm-data/sql/vamps.sql
```
