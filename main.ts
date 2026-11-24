// Pump.fun Paper Sprint — paper-trading bot for the agent-fun/replay/v2 harness.
//
// Design: capital preservation first, upside second. Local study of the
// kit's dev window showed that on a hostile tape every aggressive pump.fun
// pattern bleeds several SOL, so this bot trades like it expects a hostile
// tape: it buys only coins with real traction on their bonding curve, keeps
// every position small against the curve's real reserves, exits fast, and
// obeys two hard circuit breakers — entries stop at a 12% equity drawdown
// and everything is sold at 20%, far inside the competition's 50% ceiling.
//
// Phase one is breadth: cheap round trips of at least 0.01 SOL on at least
// 20 distinct coins, which the guardrails demand before any entry ranks
// above the cash-sitters. Phase two is selective: bigger size only on the
// same traction signal or on a reversal setup (a deep drawdown from the
// peak with buy flow resuming), with a trailing stop to let winners run.
//
// Everything is deterministic: no clocks, no randomness, every decision is
// a pure function of the hello and batch messages, so the two graded
// executions produce byte-identical action logs.

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Tunables (lamports unless noted). 1 SOL = 1_000_000_000 lamports.
// ---------------------------------------------------------------------------
const MIN_ENTRY_QUOTE = 11_000_000; // just above the 0.01 SOL round-trip bar
const RESERVE_FRACTION = 0.008; // share of real reserve used (cap is 0.01)
const MIN_REAL_RESERVE = 2_000_000_000; // 2 SOL of real reserve = traction
const FLOW_WINDOW_SLOTS = 150; // trailing flow window (~1 minute)
const MIN_WINDOW_BUY = 800_000_000; // 0.8 SOL of buys inside the window
const MIN_BUY_RATIO = 1.8; // buy volume / sell volume inside the window
const MIN_WINDOW_TRADES = 8;
const MIN_PRICE_GAIN = 0.03; // price up at least 3% over the window
const MAX_PRICE_GAIN = 0.8; // ... but not up 80%+: too late, too vertical
const ROUND_TRIP_TARGET = 20; // distinct coins the guardrails ask for
// Phase one (breadth): small size, quick exits.
const P1_MAX_QUOTE = 30_000_000;
const P1_TAKE_PROFIT = 0.18;
const P1_STOP_LOSS = 0.1;
const P1_MAX_HOLD = 450;
// Phase two (selective): larger size, room to run, trailing stop.
const P2_MAX_QUOTE = 90_000_000;
const P2_TAKE_PROFIT = 0.35;
const P2_STOP_LOSS = 0.13;
const P2_MAX_HOLD = 1500;
const TRAIL_ARM = 0.2; // trailing stop arms at +20%
const TRAIL_DROP = 0.1; // ... and fires 10% under the peak
// Reversal setup (phase two only): deep dip, buyers coming back.
const REV_MIN_RESERVE = 3_000_000_000;
const REV_DRAWDOWN = 0.4; // price at least 40% under its peak
const REV_WINDOW_SLOTS = 75;
const REV_MIN_BUY = 300_000_000;
const REV_MIN_RATIO = 1.5;
// Risk frame.
const RUG_RESERVE_DROP = 0.4; // real reserve under 40% of entry level = rug
const SLIPPAGE_BPS = 1500; // tolerance so fills survive 2 slots of latency
const DD_HALT_ENTRIES = 0.12; // stop opening positions at this drawdown
const DD_EXIT_ALL = 0.2; // sell everything at this drawdown
const P2_LOSS_BUDGET = 600_000_000; // realised loss that ends phase two
const MAX_ENTRIES_PER_COIN = 2;
const REENTRY_COOLDOWN = 1500; // slots after an exit before re-entering

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
  fee_lamports: string;
  tx_fee_lamports: string;
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
// Per-coin market memory and bookkeeping.
// ---------------------------------------------------------------------------
interface CoinState {
  mint: string;
  price: number; // virtual quote / virtual token, lamports per token unit
  peakPrice: number;
  realReserve: number; // lamports of real SOL in the curve
  complete: boolean;
  tradeSlots: number[];
  tradeBuy: number[]; // lamports, 0 when the trade was a sell
  tradeSell: number[];
  windowStartPrice: number;
  entriesUsed: number;
  lastExitSlot: number;
}
interface HeldState {
  mint: string;
  entryPrice: number;
  entrySlot: number;
  entryRealReserve: number;
  peakPrice: number;
  exitPending: boolean;
  buyQuote: number; // lamports actually spent (from the fill)
  buyFees: number; // curve + tx fees paid on the buy fill
  phase: number;
}

const coins = new Map<string, CoinState>();
const held = new Map<string, HeldState>();
const entryPending = new Map<string, number>(); // mint -> phase it was opened in
const roundTripped = new Set<string>();
let cash = 0;
let maxOpen = 5;
let maxOrdersPerBatch = 16;
let orderSeq = 0;
let equityPeak = 0;
let realisedPnl = 0; // lamports, from fills, net of every fee we can see

function priceOf(vQuote: number, vToken: number): number {
  return vToken > 0 ? vQuote / vToken : 0;
}

function coinFor(mint: string): CoinState {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      price: 0,
      peakPrice: 0,
      realReserve: 0,
      complete: false,
      tradeSlots: [],
      tradeBuy: [],
      tradeSell: [],
      windowStartPrice: 0,
      entriesUsed: 0,
      lastExitSlot: -1,
    };
    coins.set(mint, c);
  }
  return c;
}

function pruneFlow(c: CoinState, slot: number, window: number): void {
  const cutoff = slot - window;
  let drop = 0;
  while (drop < c.tradeSlots.length && c.tradeSlots[drop] < cutoff) drop++;
  if (drop > 0) {
    c.tradeSlots.splice(0, drop);
    c.tradeBuy.splice(0, drop);
    c.tradeSell.splice(0, drop);
  }
  if (c.tradeSlots.length === 0) c.windowStartPrice = c.price;
}

function windowFlow(c: CoinState, slot: number, window: number): { buy: number; sell: number; n: number } {
  let buy = 0;
  let sell = 0;
  let n = 0;
  for (let i = 0; i < c.tradeSlots.length; i++) {
    if (c.tradeSlots[i] >= slot - window) {
      buy += c.tradeBuy[i];
      sell += c.tradeSell[i];
      n++;
    }
  }
  return { buy, sell, n };
}

function applyEvent(ev: TradeLike, slot: number): void {
  const c = coinFor(ev.mint);
  if (ev.event === "CompleteEvent") {
    c.complete = true;
    return;
  }
  if (ev.virtual_sol_reserves !== undefined && ev.virtual_token_reserves !== undefined) {
    const p = priceOf(Number(ev.virtual_sol_reserves), Number(ev.virtual_token_reserves));
    if (p > 0) {
      c.price = p;
      if (p > c.peakPrice) c.peakPrice = p;
    }
  }
  if (ev.real_sol_reserves !== undefined) {
    c.realReserve = Number(ev.real_sol_reserves);
  }
  if (ev.event === "TradeEvent") {
    if (c.tradeSlots.length === 0) c.windowStartPrice = c.price;
    const amt = Number(ev.sol_amount ?? "0");
    c.tradeSlots.push(slot);
    c.tradeBuy.push(ev.is_buy ? amt : 0);
    c.tradeSell.push(ev.is_buy ? 0 : amt);
    if (c.tradeSlots.length > 512) {
      const drop = c.tradeSlots.length - 512;
      c.tradeSlots.splice(0, drop);
      c.tradeBuy.splice(0, drop);
      c.tradeSell.splice(0, drop);
    }
  }
}

function applyMark(m: Mark): void {
  const c = coinFor(m.mint);
  const p = priceOf(Number(m.virtual_quote_reserves), Number(m.virtual_token_reserves));
  if (p > 0) {
    c.price = p;
    if (p > c.peakPrice) c.peakPrice = p;
  }
  c.realReserve = Number(m.real_quote_reserves);
}

function applyFill(f: Fill, slot: number): void {
  const fees = Number(f.fee_lamports) + Number(f.tx_fee_lamports);
  if (f.side === "buy") {
    const phase = entryPending.get(f.mint) ?? 1;
    entryPending.delete(f.mint);
    if (f.status === "filled") {
      const tokens = Number(f.token_amount);
      const quote = Number(f.quote_lamports);
      realisedPnl -= fees;
      if (tokens > 0 && quote > 0) {
        const c = coins.get(f.mint);
        held.set(f.mint, {
          mint: f.mint,
          entryPrice: quote / tokens,
          entrySlot: -1, // stamped on this batch, in decide()
          entryRealReserve: c ? c.realReserve : 0,
          peakPrice: quote / tokens,
          exitPending: false,
          buyQuote: quote,
          buyFees: fees,
          phase,
        });
        if (c) c.entriesUsed++;
      }
    } else {
      realisedPnl -= Number(f.tx_fee_lamports); // a failed buy still cost its tx fee
    }
  } else if (f.side === "sell") {
    const h = held.get(f.mint);
    if (h) {
      if (f.status === "filled") {
        realisedPnl += Number(f.quote_lamports) - h.buyQuote - fees;
        held.delete(f.mint);
        const c = coins.get(f.mint);
        if (c) c.lastExitSlot = slot;
        if (h.buyQuote >= 10_000_000) roundTripped.add(f.mint);
      } else {
        h.exitPending = false; // let the exit logic try again
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry signals. Both return true when the coin qualifies right now.
// ---------------------------------------------------------------------------
function tractionSignal(c: CoinState, slot: number): boolean {
  if (c.realReserve < MIN_REAL_RESERVE || c.price <= 0) return false;
  pruneFlow(c, slot, FLOW_WINDOW_SLOTS);
  const flow = windowFlow(c, slot, FLOW_WINDOW_SLOTS);
  if (flow.n < MIN_WINDOW_TRADES || flow.buy < MIN_WINDOW_BUY) return false;
  if (flow.buy < MIN_BUY_RATIO * Math.max(flow.sell, 1)) return false;
  const gain = c.windowStartPrice > 0 ? c.price / c.windowStartPrice - 1 : 0;
  return gain >= MIN_PRICE_GAIN && gain <= MAX_PRICE_GAIN;
}

function reversalSignal(c: CoinState, slot: number): boolean {
  if (c.realReserve < REV_MIN_RESERVE || c.price <= 0 || c.peakPrice <= 0) return false;
  if (c.price > c.peakPrice * (1 - REV_DRAWDOWN)) return false;
  const flow = windowFlow(c, slot, REV_WINDOW_SLOTS);
  if (flow.buy < REV_MIN_BUY) return false;
  return flow.buy >= REV_MIN_RATIO * Math.max(flow.sell, 1);
}

function entryQuote(c: CoinState, phase: number): number {
  const capByReserve = Math.floor(c.realReserve * RESERVE_FRACTION);
  const capByPhase = phase === 1 ? P1_MAX_QUOTE : P2_MAX_QUOTE;
  const quote = Math.min(capByPhase, capByReserve, Math.floor(cash * 0.04));
  return quote >= MIN_ENTRY_QUOTE ? quote : 0;
}

// ---------------------------------------------------------------------------
// Decisions for one batch. Returns the orders to send in the reply.
// ---------------------------------------------------------------------------
function decide(batch: Batch): Order[] {
  const slot = batch.slot;
  cash = Number(batch.account.cash_lamports);
  const positions = batch.account.positions;
  const orders: Order[] = [];

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
  const drawdown = equityPeak > 0 ? 1 - equity / equityPeak : 0;
  const exitAll = drawdown >= DD_EXIT_ALL;
  const haltEntries = drawdown >= DD_HALT_ENTRIES;
  const phase = roundTripped.size < ROUND_TRIP_TARGET ? 1 : 2;
  const phaseTwoLive = phase === 2 && realisedPnl > -P2_LOSS_BUDGET;

  // --- exits first: they free slots and lock in the round trips -----------
  for (const p of positions) {
    if (orders.length >= maxOrdersPerBatch) break;
    const h = held.get(p.mint);
    const c = coins.get(p.mint);
    if (!h || !c || h.exitPending || c.price <= 0) continue;
    if (c.price > h.peakPrice) h.peakPrice = c.price;
    const gain = c.price / h.entryPrice - 1;
    const tp = h.phase === 1 ? P1_TAKE_PROFIT : P2_TAKE_PROFIT;
    const sl = h.phase === 1 ? P1_STOP_LOSS : P2_STOP_LOSS;
    const maxHold = h.phase === 1 ? P1_MAX_HOLD : P2_MAX_HOLD;
    const peakGain = h.peakPrice / h.entryPrice - 1;
    const trailHit =
      h.phase === 2 && peakGain >= TRAIL_ARM && c.price <= h.peakPrice * (1 - TRAIL_DROP);
    const rug = h.entryRealReserve > 0 && c.realReserve < h.entryRealReserve * RUG_RESERVE_DROP;
    const aged = h.entrySlot >= 0 && slot - h.entrySlot > maxHold;
    if (exitAll || gain >= tp || gain <= -sl || trailHit || rug || aged || c.complete) {
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
  const openCount = positions.length + entryPending.size;
  if (!haltEntries && !exitAll && openCount < maxOpen && (phase === 1 || phaseTwoLive)) {
    const seen = new Set<string>();
    const candidates: { mint: string; score: number }[] = [];
    for (const ev of batch.events) {
      if (ev.event !== "TradeEvent" || seen.has(ev.mint)) continue;
      seen.add(ev.mint);
      const c = coins.get(ev.mint);
      if (!c || c.complete || held.has(ev.mint) || entryPending.has(ev.mint)) continue;
      if (c.entriesUsed >= MAX_ENTRIES_PER_COIN) continue;
      if (c.lastExitSlot >= 0 && slot - c.lastExitSlot < REENTRY_COOLDOWN) continue;
      let score = 0;
      if (tractionSignal(c, slot)) score = windowFlow(c, slot, FLOW_WINDOW_SLOTS).buy;
      else if (phase === 2 && reversalSignal(c, slot)) score = windowFlow(c, slot, REV_WINDOW_SLOTS).buy;
      if (score <= 0) continue;
      // Breadth first: until the target is met, prefer coins not yet tripped.
      const freshBonus = phase === 1 && !roundTripped.has(ev.mint) ? 1e18 : 0;
      candidates.push({ mint: ev.mint, score: freshBonus + score });
    }
    candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1));
    let slots = maxOpen - openCount;
    for (const cand of candidates) {
      if (slots <= 0 || orders.length >= maxOrdersPerBatch) break;
      const c = coins.get(cand.mint);
      if (!c) continue;
      const quote = entryQuote(c, phase);
      if (quote <= 0) continue;
      entryPending.set(cand.mint, phase);
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
    for (const f of batch.fills) applyFill(f, batch.slot);
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
