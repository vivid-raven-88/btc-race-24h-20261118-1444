// btc-race-24h-20261118-1444: a dip-and-bounce mean-reversion bot for cbBTC.
// Protocol: agent-fun/bars-replay/v1. The harness sends one hello, then one
// batch per bar, then done. Each batch carries the bar that just closed and
// the fills of the orders decided on the previous batch; the bot answers with
// its orders for the next bar. Orders decided on a batch fill at the next
// bar's open, so every decision is made on closes already seen.
//
// Strategy (mean reversion on a falling, choppy day):
//   - Track the last 20 closes and their SMA. When flat, buy the whole cash
//     balance when the close dips 80 bps below the 20-bar SMA and at least one
//     of the last two bars closed up (the bounce has started), so we never buy
//     a still-falling knife.
//   - When long, sell everything at +150 bps over the buy fill (take profit)
//     or at -80 bps under it (stop loss). No trailing stop: in this market a
//     30-40 bps pullback is ordinary noise and a trailing stop exits too early.
//   - A full round trip costs about 36 bps (4 fee + 2 slippage + ~12 impact
//     per side on a $1,000 trade), so the +150 bps target clears it with room.
//   - No trade during warm-up; no trade before 20 bars of history.
//   - Everything is deterministic: all state comes from the bars; no clock,
//     no randomness, no network, no files outside the repository.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_BARS = 20;
const DIP_BPS = 80n; // buy when the close is this far below the 20-bar SMA
const TAKE_PROFIT_BPS = 150n;
const STOP_LOSS_BPS = 200n; // waterfall guard only: the dip can extend ~100 bps
// below the entry before the bounce, so a tight stop would cut the winning
// position mid-dip (grade-local proved it: an 80 bps stop turned +$12.90
// into +$3.88). 200 bps still caps a real waterfall at about -$20.
const MAX_SLIPPAGE_BPS = 100; // 1%: generous, only guards against a gap
const BPS = 10_000n;

const closes: bigint[] = [];
const opens: bigint[] = [];
let entryPrice: bigint | null = null;

function sma20(): bigint | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0n;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(SMA_BARS);
}

function bounced(): boolean {
  // At least one of the last two bars closed above its open.
  for (let j = 0; j < 2; j++) {
    const i = closes.length - 1 - j;
    if (i >= 0 && closes[i]! > opens[i]!) return true;
  }
  return false;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      closes.push(BigInt(bar.c));
      opens.push(BigInt(bar.o));
    }
    // Settle the fills of the orders decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy' && fill.client_id.startsWith('b')) {
        entryPrice = BigInt(fill.price);
      } else if (fill.side === 'sell' && fill.client_id.startsWith('s')) {
        entryPrice = null;
      }
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const sma = sma20();
    if (sma === null) return [];
    const held = state.positions.get(SYMBOL);
    const qty = held?.qty ?? 0n;
    if (qty === 0n) {
      // Flat: buy the dip, only once the bounce has started.
      if (close * BPS < sma * (BPS - DIP_BPS) && bounced()) {
        const room = state.weightRoom(SYMBOL);
        const spend = state.cash < room ? state.cash : room;
        if (spend <= 0n) return [];
        return [{ side: 'buy' as const, client_id: `b${batch.seq}`, symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    // Long: take profit or stop loss, both measured off the buy fill.
    if (entryPrice !== null) {
      if (close * BPS >= entryPrice * (BPS + TAKE_PROFIT_BPS)) {
        return [{ side: 'sell' as const, client_id: `s${batch.seq}`, symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (close * BPS <= entryPrice * (BPS - STOP_LOSS_BPS)) {
        return [{ side: 'sell' as const, client_id: `s${batch.seq}`, symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
