// Pump.fun Paper Sprint — paper-trading bot for the agent-fun/replay/v2 harness.
//
// Strategy in one paragraph: only touch coins that already show traction on
// their bonding curve (enough real SOL reserve that a sane order fits under
// the harness's reserve cap), enter when recent flow is dominated by buyers
// and the price is climbing but not vertical, size small, and leave fast —
// fixed take-profit, trailing stop, hard stop-loss, a max hold time and a
// rug guard on collapsing reserves. The first goal is breadth: complete
// round trips of at least 0.01 SOL on at least 20 distinct coins, which the
// competition's guardrails demand, while keeping drawdown far under the
// 50% ceiling. Everything is deterministic: no clocks, no randomness, every
// decision is a pure function of the hello and batch messages, so the two
// graded executions produce byte-identical action logs.

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Tunables (lamports unless noted). 1 SOL = 1_000_000_000 lamports.
// ---------------------------------------------------------------------------
const MIN_ENTRY_QUOTE = 11_000_000; // just above the 0.01 SOL round-trip bar
const MAX_ENTRY_QUOTE = 120_000_000; // 0.12 SOL per position, hard cap
const CASH_FRACTION_PER_TRADE = 0.04; // of current cash, per entry
const RESERVE_FRACTION = 0.009; // share of real reserve used (cap is 0.01)
const MIN_REAL_RESERVE = 1_500_000_000; // 1.5 SOL of real reserve = traction
const FLOW_WINDOW_SLOTS = 150; // trailing flow window (~1 minute)
const MIN_WINDOW_BUY = 800_000_000; // 0.8 SOL of buys inside the window
const MIN_BUY_RATIO = 1.6; // buy volume / sell volume inside the window
const MIN_WINDOW_TRADES = 6;
const MIN_PRICE_GAIN = 0.05; // price must be up at least 5% over the window
const MAX_PRICE_GAIN = 1.2; // ... but not up 120%+: too late, too vertical
const TAKE_PROFIT = 0.3; // +30% and the whole position goes
const TRAIL_ARM = 0.2; // trailing stop arms at +20%
const TRAIL_DROP = 0.12; // ... and fires 12% under the peak
const STOP_LOSS = 0.18; // -18% and the whole position goes
const MAX_HOLD_SLOTS = 900; // ~6 minutes, then out at whatever price
const RUG_RESERVE_DROP = 0.4; // real reserve under 40% of entry level = rug
const ROUND_TRIP_TARGET = 20; // distinct coins the guardrails ask for
const SLIPPAGE_BPS = 1200; // tolerance so fills survive 2 slots of latency
const EQUITY_DD_HALT = 0.35; // stop opening positions past this drawdown

// ---------------------------------------------------------------------------
// Protocol shapes (only the fields this bot reads).
// ---------------------------------------------------------------------------
interface TradeLike {
  event: string;
  mint: string;
  sol_amount?: string;
  is_buy?: boolean;
  virtual_sol_reserves?: string;
  virtual_token_reserves?: string;
  real_sol_reserves?: string;
  slot: number;
}
interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_quote_reserves: string;
}
interface Fill {
  client_id: string;
  mint: string;
  side: string;
  status: string;
  quote_lamports: string;
  token_amount: string;
}
interface Position {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}
interface Batch {
  type: string;
  seq: number;
  slot: number;
  events: TradeLike[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: string; positions: Position[] };
}
interface Order {
  side: string;
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ---------------------------------------------------------------------------
// Per-coin market memory.
// ---------------------------------------------------------------------------
interface CoinState {
  mint: string;
  price: number; // virtual quote / virtual token, lamports per token unit
  realReserve: number; // lamports of real SOL in the curve
  firstSlot: number;
  complete: boolean;
  // trailing flow: parallel ring buffers of recent trades
  tradeSlots: number[];
  tradeBuy: number[]; // lamports, 0 when the trade was a sell
  tradeSell: number[];
  // price at the start of the flow window, refreshed as trades age out
  windowStartPrice: number;
  windowStartSlot: number;
}
interface HeldState {
  mint: string;
  entryPrice: number;
  entrySlot: number;
  entryRealReserve: number;
  peakPrice: number;
  exitPending: boolean;
  buyQuote: number; // lamports actually spent (from the fill)
}

const coins = new Map<string, CoinState>();
const held = new Map<string, HeldState>();
const entryPending = new Set<string>();
const roundTripped = new Set<string>();
let cash = 0;
let maxOpen = 5;
let maxOrdersPerBatch = 16;
let orderSeq = 0;
let equityPeak = 0;
let entriesHalted = false;

function priceOf(vQuote: number, vToken: number): number {
  return vToken > 0 ? vQuote / vToken : 0;
}

function coinFor(mint: string, slot: number): CoinState {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      price: 0,
      realReserve: 0,
      firstSlot: slot,
      complete: false,
      tradeSlots: [],
      tradeBuy: [],
      tradeSell: [],
      windowStartPrice: 0,
      windowStartSlot: slot,
    };
    coins.set(mint, c);
  }
  return c;
}

// Drop trades older than the flow window and keep the window's opening price.
function pruneFlow(c: CoinState, slot: number): void {
  const cutoff = slot - FLOW_WINDOW_SLOTS;
  let drop = 0;
  while (drop < c.tradeSlots.length && c.tradeSlots[drop] < cutoff) drop++;
  if (drop > 0) {
    c.tradeSlots.splice(0, drop);
    c.tradeBuy.splice(0, drop);
    c.tradeSell.splice(0, drop);
  }
  if (c.tradeSlots.length === 0) {
    c.windowStartPrice = c.price;
    c.windowStartSlot = slot;
  }
}

function windowFlow(c: CoinState): { buy: number; sell: number; n: number } {
  let buy = 0;
  let sell = 0;
  for (let i = 0; i < c.tradeSlots.length; i++) {
    buy += c.tradeBuy[i];
    sell += c.tradeSell[i];
  }
  return { buy, sell, n: c.tradeSlots.length };
}

function applyEvent(ev: TradeLike, slot: number): void {
  const c = coinFor(ev.mint, slot);
  if (ev.event === "CompleteEvent") {
    c.complete = true;
    return;
  }
  if (ev.virtual_sol_reserves !== undefined && ev.virtual_token_reserves !== undefined) {
    const p = priceOf(Number(ev.virtual_sol_reserves), Number(ev.virtual_token_reserves));
    if (p > 0) c.price = p;
  }
  if (ev.real_sol_reserves !== undefined) {
    c.realReserve = Number(ev.real_sol_reserves);
  }
  if (ev.event === "TradeEvent") {
    if (c.tradeSlots.length === 0) {
      c.windowStartPrice = c.price;
      c.windowStartSlot = slot;
    }
    const amt = Number(ev.sol_amount ?? "0");
    c.tradeSlots.push(slot);
    c.tradeBuy.push(ev.is_buy ? amt : 0);
    c.tradeSell.push(ev.is_buy ? 0 : amt);
    if (c.tradeSlots.length > 512) {
      c.tradeSlots.splice(0, c.tradeSlots.length - 512);
      c.tradeBuy.splice(0, c.tradeBuy.length - 512);
      c.tradeSell.splice(0, c.tradeSell.length - 512);
    }
  }
}

function applyMark(m: Mark): void {
  const c = coinFor(m.mint, m.slot);
  const p = priceOf(Number(m.virtual_quote_reserves), Number(m.virtual_token_reserves));
  if (p > 0) c.price = p;
  c.realReserve = Number(m.real_quote_reserves);
}

function applyFill(f: Fill): void {
  if (f.side === "buy") {
    entryPending.delete(f.mint);
    if (f.status === "filled") {
      const tokens = Number(f.token_amount);
      const quote = Number(f.quote_lamports);
      if (tokens > 0 && quote > 0) {
        const c = coins.get(f.mint);
        held.set(f.mint, {
          mint: f.mint,
          entryPrice: quote / tokens,
          entrySlot: -1, // stamped on the next batch, in decide()
          entryRealReserve: c ? c.realReserve : 0,
          peakPrice: quote / tokens,
          exitPending: false,
          buyQuote: quote,
        });
      }
    }
  } else if (f.side === "sell") {
    const h = held.get(f.mint);
    if (h) {
      if (f.status === "filled") {
        held.delete(f.mint);
        if (h.buyQuote >= 10_000_000) roundTripped.add(f.mint);
      } else {
        h.exitPending = false; // let the exit logic try again
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decisions for one batch. Returns the orders to send in the reply.
// ---------------------------------------------------------------------------
function decide(batch: Batch): Order[] {
  const slot = batch.slot;
  cash = Number(batch.account.cash_lamports);
  const positions = batch.account.positions;
  const orders: Order[] = [];

  // Stamp entry slots for positions whose buy fill just landed.
  for (const h of held.values()) {
    if (h.entrySlot < 0) h.entrySlot = slot;
  }

  // Equity and drawdown, marked at the latest prices we know.
  let equity = cash;
  for (const p of positions) {
    const c = coins.get(p.mint);
    if (c && c.price > 0) equity += Number(p.token_amount) * c.price;
    else equity += Number(p.cost_lamports);
  }
  if (equity > equityPeak) equityPeak = equity;
  if (equityPeak > 0 && equity < equityPeak * (1 - EQUITY_DD_HALT)) {
    entriesHalted = true;
  }

  const openCount = positions.length + entryPending.size;

  // --- exits first: they free slots and lock in the round trips -----------
  for (const p of positions) {
    if (orders.length >= maxOrdersPerBatch) break;
    const h = held.get(p.mint);
    const c = coins.get(p.mint);
    if (!h || !c || h.exitPending || c.price <= 0) continue;
    if (c.price > h.peakPrice) h.peakPrice = c.price;
    const gain = c.price / h.entryPrice - 1;
    const peakGain = h.peakPrice / h.entryPrice - 1;
    const trailHit = peakGain >= TRAIL_ARM && c.price <= h.peakPrice * (1 - TRAIL_DROP);
    const rug = h.entryRealReserve > 0 && c.realReserve < h.entryRealReserve * RUG_RESERVE_DROP;
    const aged = h.entrySlot >= 0 && slot - h.entrySlot > MAX_HOLD_SLOTS;
    if (gain >= TAKE_PROFIT || gain <= -STOP_LOSS || trailHit || rug || aged || c.complete) {
      h.exitPending = true;
      orderSeq++;
      orders.push({
        side: "sell",
        client_id: `s${batch.seq}-${orderSeq}`,
        mint: p.mint,
        token_amount: p.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }

  // --- entries -------------------------------------------------------------
  if (!entriesHalted && openCount < maxOpen) {
    // Candidates: coins with a trade in this batch, scored by window flow.
    const seen = new Set<string>();
    const candidates: { mint: string; score: number }[] = [];
    for (const ev of batch.events) {
      if (ev.event !== "TradeEvent" || seen.has(ev.mint)) continue;
      seen.add(ev.mint);
      const c = coins.get(ev.mint);
      if (!c || c.complete || held.has(ev.mint) || entryPending.has(ev.mint)) continue;
      if (c.realReserve < MIN_REAL_RESERVE || c.price <= 0) continue;
      pruneFlow(c, slot);
      const flow = windowFlow(c);
      if (flow.n < MIN_WINDOW_TRADES || flow.buy < MIN_WINDOW_BUY) continue;
      if (flow.sell > 0 && flow.buy / flow.sell < MIN_BUY_RATIO) continue;
      if (flow.sell === 0 && flow.buy < MIN_WINDOW_BUY * 2) continue;
      const gain = c.windowStartPrice > 0 ? c.price / c.windowStartPrice - 1 : 0;
      if (gain < MIN_PRICE_GAIN || gain > MAX_PRICE_GAIN) continue;
      // Breadth first: until the round-trip target is met, prefer fresh coins.
      const freshBonus = roundTripped.size < ROUND_TRIP_TARGET && !roundTripped.has(ev.mint) ? 1 : 0;
      candidates.push({ mint: ev.mint, score: freshBonus * 1e18 + flow.buy });
    }
    candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1));
    let slots = maxOpen - openCount;
    for (const cand of candidates) {
      if (slots <= 0 || orders.length >= maxOrdersPerBatch) break;
      const c = coins.get(cand.mint);
      if (!c) continue;
      let quote = Math.min(
        MAX_ENTRY_QUOTE,
        Math.floor(cash * CASH_FRACTION_PER_TRADE),
        Math.floor(c.realReserve * RESERVE_FRACTION),
      );
      if (quote < MIN_ENTRY_QUOTE) continue;
      quote = Math.floor(quote);
      entryPending.add(cand.mint);
      orderSeq++;
      orders.push({
        side: "buy",
        client_id: `b${batch.seq}-${orderSeq}`,
        mint: cand.mint,
        quote_lamports: String(quote),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      cash -= quote;
      slots--;
    }
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Main loop: hello, then one reply per batch, exit on done.
// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: { type?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    const hello = msg as {
      capital: { lamports: string };
      caps: { max_open_positions: number; max_orders_per_batch: number };
    };
    cash = Number(hello.capital.lamports);
    equityPeak = cash;
    maxOpen = hello.caps.max_open_positions;
    maxOrdersPerBatch = hello.caps.max_orders_per_batch;
    return;
  }
  if (msg.type === "batch") {
    const batch = msg as unknown as Batch;
    for (const f of batch.fills) applyFill(f);
    for (const ev of batch.events) applyEvent(ev, batch.slot);
    for (const m of batch.marks) applyMark(m);
    const orders = decide(batch);
    process.stdout.write(JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n");
    return;
  }
  if (msg.type === "done") {
    process.exit(0);
  }
});
