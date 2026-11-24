// Filtered launch scalper for the pump.fun bonding-curve replay.
//
// What the kit's calibration window (2-3 Nov 2026, 1222 universe coins) actually
// rewards, after testing momentum, sniper, reversion, early-reserve breakout,
// ride-to-completion and buy-and-hold variants — all of which lose money here:
// buying a launch is only worth it when the creator has real skin in the game
// (0.1-1 SOL of their own buys) and NOBODY has sold yet, and only in a tiny
// 0.01 SOL size. Everything else is noise the 2-slot latency and the 1.25%
// curve fee eat alive: a fill lands ~10% above the decision price on a pumping
// coin, so entries after a pump and exits after a spike are both untradable.
//
// Exits use the one free option the harness gives: a rejected order costs
// nothing. Once a position is up 5%, every batch attempts a full sell with a
// tight 2% slippage — it only fills while the price is still there, and a
// rejection is retried next batch for free. Losers are cut at -50% (wide
// slippage, always fills) or on a creator sell, and never held past 20000 slots.
//
// Pure function of the batches: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream, so two runs agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL a curve must hold before it may be bought. */
  minRqSol: number;
  /** Creator's own buys (SOL) before entry, at least this much (skin in the game). */
  minDevBuySol: number;
  /** ...and at most this much (a huge creator buy is usually a dump setup). */
  maxDevBuySol: number;
  /** SOL per position (one buy only, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending (also the guardrail's round-trip minimum). */
  minBuySol: number;
  /** Sell everything once the position is worth cost * (1 + goodExitUp)... */
  goodExitUp: number;
  /** ...but only when the fill would land within this share of the decision price. */
  goodExitSlipBps: number;
  /** Sell once the position is worth cost * (1 - hardStop). */
  hardStop: number;
  /** Sell after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Single recorded sell of at least this many SOL exits a held position at once. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldownSlots: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  minRqSol: 1,
  minDevBuySol: 0.1,
  maxDevBuySol: 0.5,
  stakeSol: 0.01,
  minBuySol: 0.01,
  goodExitUp: 0.08,
  goodExitSlipBps: 200,
  hardStop: 0.5,
  maxHoldSlots: 20000,
  bigSellSol: 1.5,
  cooldownSlots: 600,
  maxEntries: 1,
};

const LAMPORTS = 1e9;
/** Curve fee on a sale (protocol 95 bps + creator 30 bps), as a share. */
const CURVE_FEE = 0.0125;

interface Tape {
  created: number | null;
  creator: string;
  /** Creator's own buys so far (SOL). */
  devBuySol: number;
  /** Any sell has hit the coin so far. */
  anySell: boolean;
  /** Creator has sold so far. */
  creatorSold: boolean;
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  /** Best close value seen (SOL, fees deducted) — kept for the record. */
  peakValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: '', devBuySol: 0, anySell: false, creatorSold: false, entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const devSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (e.is_buy && e.user === t.creator) t.devBuySol += sol;
          if (!e.is_buy) {
            t.anySell = true;
            if (e.user === t.creator) {
              t.creatorSold = true;
              devSold.add(e.mint);
            }
            if (sol >= p.bigSellSol) bigSell.add(e.mint);
          }
          traded.add(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: good exit (tight slippage, retried free), hard stop, hold
      // limit, creator sell, big sell.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            tapeOf(mint).lastExit = now;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        const hard = value < cost * (1 - p.hardStop) || now - h.opened > p.maxHoldSlots || devSold.has(mint) || bigSell.has(mint);
        const good = !hard && value >= cost * (1 + p.goodExitUp);
        if (!hard && !good) continue;
        if (orders.length >= cap) break;
        // A good exit only fills while the price holds (tight slippage); a
        // rejection costs nothing and is retried on the next batch. A hard exit
        // goes out wide open so it always lands.
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: hard ? 10_000 : p.goodExitSlipBps,
        });
      }

      // Entries: coins traded this batch whose real reserve just reached 1 SOL,
      // with the creator's own buys inside [minDevBuySol, maxDevBuySol] and no
      // sell on the tape yet.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldownSlots) continue;
        if (t.anySell || t.creatorSold) continue;
        if (t.devBuySol < p.minDevBuySol || t.devBuySol > p.maxDevBuySol) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: 10_000 });
        free -= amount + tx;
        slotsLeft--;
        t.entries++;
        held.set(mint, { opened: now, peakValue: 0 });
      }
      return orders;
    },
  };
}
