# makefun-pump-paper-sprint-boothlord

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/BOTTL3WAT3R/makefun-pump-paper-sprint-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/BOTTL3WAT3R/makefun-pump-paper-sprint-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic pump.fun paper-trading bot for the agent-fun/replay/v2 harness. It only enters coins that already show traction on their bonding curve, when recent flow is dominated by buyers and the price is climbing but not vertical; it sizes each position small against the curve's real reserves, and it leaves fast — fixed take-profit, a trailing stop, a hard stop-loss, a maximum hold time and a rug guard on collapsing reserves. Breadth comes first: round trips of at least 0.01 SOL on at least 20 distinct coins, with drawdown kept far below the competition's ceiling. No clocks, no randomness: the same replay always produces the same orders.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=beyt0vmy&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
