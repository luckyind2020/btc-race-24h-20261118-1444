// Washout-and-trend BTC bot for make.fun's bars-replay/v1 harness.
//
// The bot trades one symbol, CBBTC, long only, on 1-minute bars,
// starting with $1,000 of paper USDC. It is deliberately patient: most
// minutes it does nothing. It buys only on one of two high-conviction
// setups, holds with a wide trailing stop, and stops entering after two
// losing round trips or $12 of realised losses, so a choppy day cannot
// bleed it.
//
// Setup 1 - washout: the close prints at least 1.20% under its 60-bar
// exponential average. A sharp selloff usually snaps back at least a
// little; the entry buys the washout itself, not the falling knife's
// first tick, because the average has to be that far above the price.
//
// Setup 2 - confirmed trend: the close is up more than 0.40% over the
// last 60 bars AND more than 0.50% over the last 120 bars. One hour of
// strength can be noise; two hours of it is a trend worth riding.
//
// Exit - trailing stop: once in, the bot tracks the highest close since
// the fill and sells the whole position when the close falls 0.80% under
// that peak. A hard stop 1.20% under the filled entry caps the damage
// if the move reverses at once. Both exits are wide on purpose: a
// 1-minute bar jitters about 0.07%, so a tight stop is just a fee
// donation.
//
// Costs: every fill pays 4 bps in fees plus 2 bps of modelled slippage
// plus its own price impact against the pool, so a full-size round trip
// costs roughly 26 bps. Both setups only fire on moves several times
// that size, which is why the bot would rather sit in cash than trade
// small wiggles.
//
// Determinism: every decision is an integer function of the bars seen
// so far. No clock, no environment, no randomness, no network, no files
// outside this repository. The same bars always produce the same orders.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Prices arrive at price_scale 5 (raw units of 0.00001 USD) and cash at
// quote_scale 6 (raw units of 0.000001 USDC). Every comparison below is
// an integer basis-point ratio, so no floats ever enter a decision.
const BPS = 10_000n;

const EMA_BARS = 60;
const DIP_BPS = 120n;          // washout: close 1.20% under the 60-bar average
const MOM60_BPS = 40n;         // trend leg: +0.40% over the last 60 bars
const MOM120_BPS = 50n;        // trend leg: +0.50% over the last 120 bars
const TRAIL_BPS = 80n;         // trailing stop: 0.80% under the peak close
const HARD_BPS = 120n;         // hard stop: 1.20% under the filled entry
const SLIP_CAP_BPS = 150;      // refuse a fill more than 1.50% past the close
const MAX_LOSSES = 2;          // circuit breaker: losing round trips allowed
const LOSS_CAP_UNITS = 12_000_000n;  // ... or $12.00 of realised losses
const HISTORY_BARS = 130;      // closes kept: enough for the 120-bar lookback

// The bot's whole memory: price history, the open trade, the breaker.
class Ledger {
  closes: bigint[] = [];
  average: bigint | null = null;
  peak = 0n;
  entryPrice = 0n;
  cashBeforeBuy = 0n;
  wasHolding = false;
  losses = 0;
  realised = 0n;
  minNotional = 0n;

  noteClose(close: bigint): void {
    this.closes.push(close);
    if (this.closes.length > HISTORY_BARS) this.closes.shift();
    if (this.average === null) {
      this.average = close;
    } else {
      // Classic EMA with alpha 2 / (EMA_BARS + 1), kept in integers.
      this.average = (2n * close + BigInt(EMA_BARS - 1) * this.average) / BigInt(EMA_BARS + 1);
    }
  }

  washout(close: bigint): boolean {
    if (this.average === null) return false;
    return close * BPS < this.average * (BPS - DIP_BPS);
  }

  trending(close: bigint): boolean {
    if (this.closes.length <= 120) return false;
    const hour = (close * BPS) / this.closes[this.closes.length - 61] - BPS;
    const twoHour = (close * BPS) / this.closes[this.closes.length - 121] - BPS;
    return hour > MOM60_BPS && twoHour > MOM120_BPS;
  }

  breakerTripped(): boolean {
    return this.losses >= MAX_LOSSES || this.realised <= -LOSS_CAP_UNITS;
  }
}

const LEDGER = new Ledger();

function heldQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
}

function entryPrice(state: BarsState): bigint {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty <= 0n) return 0n;
  // cost (USDC raw) -> price (raw): price = cost * 10^7 / qty.
  return (held.cost * 10_000_000n) / held.qty;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const close = state.close(SYMBOL);
  if (close === null) return [];

  const holding = heldQty(state) > 0n;

  // A round trip just closed: score it for the circuit breaker. Cash
  // before the buy versus cash now is the trade's exact net result,
  // fees and impact included, because no other trade can intervene.
  if (LEDGER.wasHolding && !holding) {
    const result = state.cash - LEDGER.cashBeforeBuy;
    LEDGER.realised += result;
    if (result < 0n) LEDGER.losses += 1;
  }
  LEDGER.wasHolding = holding;

  LEDGER.noteClose(close);

  if (holding) {
    if (LEDGER.entryPrice === 0n) {
      LEDGER.entryPrice = entryPrice(state);
      LEDGER.peak = close;
    }
    if (close > LEDGER.peak) LEDGER.peak = close;
    const fellFromEntry = close * BPS <= LEDGER.entryPrice * (BPS - HARD_BPS);
    const fellFromPeak = close * BPS <= LEDGER.peak * (BPS - TRAIL_BPS);
    if (fellFromEntry || fellFromPeak) {
      LEDGER.entryPrice = 0n;
      return [{ side: 'sell', symbol: SYMBOL, qty: heldQty(state), max_slippage_bps: SLIP_CAP_BPS }];
    }
    return [];
  }

  if (LEDGER.breakerTripped()) return [];
  // A buy smaller than the venue's minimum notional is refused outright,
  // so there is no point deciding one when the cash cannot cover it.
  if (state.cash < LEDGER.minNotional) return [];
  if (LEDGER.washout(close) || LEDGER.trending(close)) {
    LEDGER.cashBeforeBuy = state.cash;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: SLIP_CAP_BPS }];
  }
  return [];
}

function onHello(state: BarsState): void {
  // Fresh run, fresh memory: the harness executes the bot twice on the
  // same bars and the two action logs must match byte for byte.
  LEDGER.minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  LEDGER.closes = [];
  LEDGER.average = null;
  LEDGER.peak = 0n;
  LEDGER.entryPrice = 0n;
  LEDGER.cashBeforeBuy = 0n;
  LEDGER.wasHolding = false;
  LEDGER.losses = 0;
  LEDGER.realised = 0n;
}

runBars({ onBatch, onHello });
