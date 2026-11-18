# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/luckyind2020/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/luckyind2020/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A patient BTC trading bot: it buys only deep washouts and confirmed multi-hour trends, then exits on a trailing stop. Most minutes it sits in cash and does nothing, because a full-size round trip costs about 26 bps in fees, slippage and impact, so small wiggles are not worth trading.

## Strategy

- **Washout entry:** buy when the close prints at least 1.20% under its 60-bar exponential average.
- **Trend entry:** buy when the close is up more than 0.40% over 60 bars and more than 0.50% over 120 bars.
- **Exit:** sell everything when the close falls 0.80% under the highest close since entry, or 1.20% under the filled entry price.
- **Circuit breaker:** stop entering after 2 losing round trips or $12 of realised losses.

## Dev result

Graded locally with the kit's own harness (`makefun grade-local`, process driver) on the published 24-hour dev window (1,440 one-minute bars of CBBTC):

- **Net PnL: +$8.43** on $1,000 starting capital (dev gate: above $0)
- Max drawdown: 1.59% (guardrail: 25%)
- 2 round trips, 4 fills, $1.60 in fees
- Deterministic: repeated grades produce the identical action log

For comparison, every house baseline loses on this window (EMA cross −$148.17, ADX momentum −$75.57, RSI-Bollinger −$39.92, buy-and-hold −$31.63, momentum −$23.87).

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout: the harness sends one JSON line per minute bar and the bot answers with one reply per batch. To grade it exactly as the server does:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Files

- `main.ts` — the bot (TypeScript, Node 22, standard library only)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's protocol shim, kept under `vendor/` as the kit's rules allow

---

<sub>Entered on [make.fun](https://make.fun/?ref=4ha9jy2z&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
