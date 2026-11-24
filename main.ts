// Early Rider — a pump.fun replay paper bot for make.fun's
// "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty.
//
// Idea: most new pump.fun coins die within minutes, and buying after a
// big run-up means buying the top. So buy EARLY: as soon as real SOL
// (1 SOL) is in the curve and a few real trades have printed, while the
// price is still near where the coin started — then ride whatever pump
// follows with a small stake, and get out fast on a stop-loss, a
// give-back from the peak, or a max hold. Sells are chunked so a single
// sell never asks for more than half of the curve's real SOL: on a dump
// the real reserves drain to almost nothing and an oversized sell is
// rejected forever, trapping the position.
//
// Deterministic: no clock, no environment, no Math.random — every
// decision comes from the batch the harness hands over (the hello message
// carries the run's seed, which this bot does not even need) and from
// insertion-ordered maps. Two runs over the same data produce the same
// orders, slot for slot.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

/** Stake per coin: 0.03 SOL. Small enough to spread 10 SOL over many coins. */
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 100n;
/** A coin must hold at least this much real SOL before it is buyable. */
const MIN_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL * 2n;
/** Trades a coin must have printed before it is buyable. */
const MIN_TRADES = 20;
/** A coin must have survived this many slots since first sight: most
 *  rugs die in the first minutes, so age is the strongest filter. */
const MIN_AGE_SLOTS = 1500;
/** Buy only once the price is at least this far above its first print. */
const BREAKOUT_NUM = 11n;
const BREAKOUT_DEN = 10n; // x1.10
/** ...and at least this far above its own low (it must be climbing, not flat). */
const OFF_LOW_NUM = 11n;
const OFF_LOW_DEN = 10n; // x1.10
/** Stop-loss: sell when the price falls to 92% of the entry price. */
const STOP_NUM = 92n;
const STOP_DEN = 100n;
/** Arm the trailing stop once the peak is 15% above entry. */
const TRAIL_ARM_NUM = 23n;
const TRAIL_ARM_DEN = 20n; // x1.15
/** ...then sell when the price gives back 20% from the peak. */
const TRAIL_NUM = 4n;
const TRAIL_DEN = 5n; // x0.80 of peak
/** Max hold, in slots (~0.4 s each, so ~10 minutes). */
const MAX_HOLD_SLOTS = 1500;
/** A single sell never takes more than half of the curve's real SOL. */
const MAX_SELL_SHARE_NUM = 1n;
const MAX_SELL_SHARE_DEN = 2n;
/** Slippage guard: 30% — wide enough that the 2-slot fill latency on a
 *  fast coin does not turn every order into a rejection. */
const MAX_SLIPPAGE_BPS = 3000;

// ---------------------------------------------------------------- price math
//
// A price is virtual_quote_reserves / virtual_token_reserves, kept as a
// numerator/denominator pair of bigints so every comparison is exact:
// a/b >= c/d  <=>  a*d >= c*b. No floats anywhere in the decision path.

interface Ratio {
  num: bigint;
  den: bigint;
}

/** price >= ratio * base ? */
function atLeast(price: Ratio, base: Ratio, num: bigint, den: bigint): boolean {
  return price.num * base.den * den >= base.num * price.den * num;
}

/** price <= ratio * base ? */
function atMost(price: Ratio, base: Ratio, num: bigint, den: bigint): boolean {
  return price.num * base.den * den <= base.num * price.den * num;
}

// ---------------------------------------------------------------- per-coin state

interface Coin {
  /** Price when the coin was first seen (its CreateEvent batch). */
  first: Ratio;
  /** Lowest price seen since first sight. */
  low: Ratio;
  /** Highest price seen since first sight. */
  peak: Ratio;
  /** Trades printed so far. */
  trades: number;
  /** Slot the coin was first seen. */
  firstSlot: number;
  /** Entry decision already taken (bought, or skipped for good). */
  decided: boolean;
  /** Slot the entry buy was decided on, once bought. */
  entrySlot: number;
  /** Price the entry buy was decided at. */
  entry: Ratio | null;
}

const coins = new Map<string, Coin>();

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- exits first: free a slot before deciding any new entry. ---
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const coin = coins.get(mint);
      if (curve === undefined || curve.complete || coin === null || coin === undefined) continue;
      if (coin.entry === null) continue;

      const price: Ratio = {
        num: curve.virtual_quote_reserves,
        den: curve.virtual_token_reserves,
      };
      // Track the peak only while we hold.
      if (price.num * coin.peak.den > coin.peak.num * price.den) coin.peak = price;

      const stopHit = atMost(price, coin.entry, STOP_NUM, STOP_DEN);
      const trailArmed = atLeast(coin.peak, coin.entry, TRAIL_ARM_NUM, TRAIL_ARM_DEN);
      const trailHit = trailArmed && atMost(price, coin.peak, TRAIL_NUM, TRAIL_DEN);
      const stale = state.slot - coin.entrySlot > MAX_HOLD_SLOTS;
      if (!stopHit && !trailHit && !stale) continue;

      // Chunk the sell: at most half the curve's real SOL in one order,
      // so a dump that drains the reserves cannot trap the whole position.
      const maxProceeds = (curve.real_quote_reserves * MAX_SELL_SHARE_NUM) / MAX_SELL_SHARE_DEN;
      // tokens whose mark value is maxProceeds: tokens = maxProceeds * vt / vq
      let sellTokens = holding.token_amount;
      if (curve.virtual_quote_reserves > 0n) {
        const chunk = (maxProceeds * curve.virtual_token_reserves) / curve.virtual_quote_reserves;
        if (chunk < sellTokens) sellTokens = chunk;
      }
      if (sellTokens <= 0n) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (free < tx) continue;
      const sell: SellInput = {
        side: "sell",
        mint,
        token_amount: sellTokens,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
      free -= tx;
      // If this sell does not clear the whole position, the rest is
      // revisited on the next batch (the position stays open).
    }

    // --- entries: one pass over this batch's events, in chain order. ---
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        if (e.event === "CompleteEvent") coins.delete(e.mint);
        continue;
      }
      let coin = coins.get(e.mint);
      if (coin === undefined) {
        coin = {
          first: { num: curve.virtual_quote_reserves, den: curve.virtual_token_reserves },
          low: { num: curve.virtual_quote_reserves, den: curve.virtual_token_reserves },
          peak: { num: curve.virtual_quote_reserves, den: curve.virtual_token_reserves },
          trades: 0,
          firstSlot: state.slot,
          decided: false,
          entrySlot: 0,
          entry: null,
        };
        coins.set(e.mint, coin);
      }
      if (e.event === "TradeEvent") coin.trades += 1;

      const price: Ratio = {
        num: curve.virtual_quote_reserves,
        den: curve.virtual_token_reserves,
      };
      if (price.num * coin.low.den < coin.low.num * price.den) coin.low = price;
      if (price.num * coin.peak.den > coin.peak.num * price.den) coin.peak = price;

      if (coin.decided) continue;
      if (coin.trades < MIN_TRADES) continue;
      if (state.slot - coin.firstSlot < MIN_AGE_SLOTS) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
      if (!atLeast(price, coin.first, BREAKOUT_NUM, BREAKOUT_DEN)) continue;
      if (!atLeast(price, coin.low, OFF_LOW_NUM, OFF_LOW_DEN)) continue;

      // Old enough to have survived the rug window, liquid, and climbing.
      // Buy once, then never again on this coin.
      coin.decided = true;
      const cap = state.maxBuyLamports(e.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount <= 0n) continue;
      if (slots <= 0) continue;
      if (free < amount + tx) continue;
      const buy: BuyInput = {
        side: "buy",
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      free -= amount + tx;
      slots -= 1;
      coin.entrySlot = state.slot;
      coin.entry = price;
    }

    return orders;
  },
});
