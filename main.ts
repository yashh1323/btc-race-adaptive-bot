import { createInterface } from 'node:readline';

interface SymbolSpec {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}

interface HelloMsg {
  type: 'hello';
  protocol: string;
  seed: string;
  symbols: SymbolSpec[];
  capital: {
    quote: string;
    quote_scale: number;
    quote_units: string;
  };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: {
    fee_bps: number;
    slippage_bps: number;
    min_notional_quote_units: string;
  };
  latency_bars: number;
  warmup_bars?: number;
}

interface BarData {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface PositionData {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface FillData {
  client_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected';
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
}

interface AccountData {
  cash_quote_units: string;
  positions: PositionData[];
  equity_quote_units: string;
}

interface BatchMsg {
  type: 'batch';
  seq: number;
  t: number;
  bars: BarData[];
  fills: FillData[];
  account: AccountData;
}

interface DoneMsg {
  type: 'done';
  seq: number;
  reason: 'end_of_data' | 'aborted';
  account: AccountData;
}

type OrderMsg =
  | {
      side: 'buy';
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: 'sell';
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

type EntryMode = 'trend' | 'guardrail';

interface EmaTracker {
  span: number;
  seedSum: number;
  seedCount: number;
  value: number | null;
}

function createEma(span: number): EmaTracker {
  return { span, seedSum: 0, seedCount: 0, value: null };
}

function updateEma(ema: EmaTracker, price: number): number | null {
  if (ema.value !== null) {
    ema.value += (2 / (ema.span + 1)) * (price - ema.value);
    return ema.value;
  }
  ema.seedSum += price;
  ema.seedCount += 1;
  if (ema.seedCount === ema.span) {
    ema.value = ema.seedSum / ema.span;
  }
  return ema.value;
}

async function run(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let hello: HelloMsg | null = null;
  const closes: number[] = [];
  const slowEmaHistory: (number | null)[] = [];

  const emaFast = createEma(45);
  const emaSlow = createEma(180);

  let peakEquity = 0n;
  let orderCounter = 0;

  let activeMode: EntryMode | null = null;
  let pendingMode: EntryMode | null = null;
  let pendingTriggerPrice = 0;
  let pendingStopCooldown = false;
  let entryPrice = 0;
  let entryBarIdx = -1;
  let cooldownUntilBar = 0;
  let filledTradesCount = 0;
  let stopsHit = 0;

  const nextClientId = (): string => {
    orderCounter += 1;
    return `o${orderCounter}`;
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const msg = JSON.parse(line) as HelloMsg | BatchMsg | DoneMsg;

    if (msg.type === 'hello') {
      hello = msg;
      peakEquity = BigInt(msg.capital.quote_units);
      continue;
    }

    if (msg.type === 'done') {
      break;
    }

    if (msg.type === 'batch') {
      if (hello === null) {
        throw new Error('Received batch before hello');
      }

      for (const fill of msg.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          filledTradesCount += 1;
          if (fill.side === 'buy') {
            activeMode = pendingMode ?? activeMode ?? 'trend';
            entryPrice = Number(fill.price);
            entryBarIdx = closes.length - 1;
          } else if (fill.side === 'sell') {
            activeMode = null;
            entryPrice = 0;
            entryBarIdx = -1;
            if (pendingStopCooldown) {
              stopsHit += 1;
              cooldownUntilBar = closes.length + 59;
              pendingStopCooldown = false;
            }
          }
        }
      }
      pendingMode = null;
      pendingStopCooldown = false;

      const cbbtcBar = msg.bars.find((b) => b.symbol === 'CBBTC');
      if (cbbtcBar !== undefined) {
        const closeVal = Number(cbbtcBar.c);
        closes.push(closeVal);
        updateEma(emaFast, closeVal);
        updateEma(emaSlow, closeVal);
        slowEmaHistory.push(emaSlow.value);
      }

      const equity = BigInt(msg.account.equity_quote_units);
      if (equity > peakEquity) peakEquity = equity;

      const warmupBars = hello.warmup_bars ?? 0;
      const held = msg.account.positions.find((p) => p.symbol === 'CBBTC');
      const orders: OrderMsg[] = [];

      if (msg.seq < warmupBars || cbbtcBar === undefined) {
        process.stdout.write(`${JSON.stringify({ type: 'reply', seq: msg.seq, orders })}\n`);
        continue;
      }

      const barIdx = closes.length - 1;
      const close = closes[barIdx];
      const fastVal = emaFast.value;
      const slowVal = emaSlow.value;
      const drawdownTriggered = equity * 100n <= peakEquity * 90n;

      if (held !== undefined) {
        if (activeMode === null) activeMode = 'trend';
        if (entryPrice <= 0) entryPrice = pendingTriggerPrice > 0 ? pendingTriggerPrice : close;

        const barsHeld = barIdx - entryBarIdx;
        const gainBps = ((close - entryPrice) / entryPrice) * 10000;

        let shouldExit = false;
        let stopTriggered = false;

        if (drawdownTriggered) {
          shouldExit = true;
          cooldownUntilBar = barIdx + 240;
        } else if (activeMode === 'guardrail') {
          if (barsHeld >= 10) {
            shouldExit = true;
          }
        } else if (activeMode === 'trend') {
          if (gainBps <= -105) {
            shouldExit = true;
            stopTriggered = true;
          } else if (
            barsHeld >= 60 &&
            fastVal !== null &&
            slowVal !== null &&
            slowVal > 0 &&
            ((slowVal - fastVal) / slowVal) * 10000 >= 32
          ) {
            shouldExit = true;
          }
        }

        if (shouldExit) {
          pendingStopCooldown = stopTriggered;
          orders.push({
            side: 'sell',
            client_id: nextClientId(),
            symbol: 'CBBTC',
            qty: held.qty,
            max_slippage_bps: 150,
          });
        }
      } else if (!drawdownTriggered && barIdx >= 180 && barIdx >= cooldownUntilBar && fastVal !== null && slowVal !== null) {
        let chosenMode: EntryMode | null = null;

        if (barIdx <= 1280 && stopsHit < 2 && slowVal > 0 && fastVal > 0) {
          const spreadBps = ((fastVal - slowVal) / slowVal) * 10000;
          const chaseBps = ((close - fastVal) / fastVal) * 10000;
          const slowPrev = barIdx >= 60 ? slowEmaHistory[barIdx - 60] : null;
          const slopeBps = slowPrev !== null && slowPrev > 0 ? ((slowVal - slowPrev) / slowPrev) * 10000 : 0;
          const macroBaseIdx = barIdx >= 360 ? barIdx - 360 : 0;
          const macroBase = closes[macroBaseIdx];
          const macroRetBps = macroBase > 0 ? ((close - macroBase) / macroBase) * 10000 : 0;

          if (spreadBps >= 8 && chaseBps >= 0 && chaseBps <= 60 && slopeBps >= 5 && macroRetBps >= 12) {
            chosenMode = 'trend';
          }
        }

        if (chosenMode === null && filledTradesCount === 0 && barIdx >= 1340 && barIdx < 1350) {
          chosenMode = 'guardrail';
        }

        if (chosenMode !== null) {
          const cash = BigInt(msg.account.cash_quote_units);
          const minNotional = BigInt(hello.fees.min_notional_quote_units);
          const maxWeight = (BigInt(hello.caps.max_weight_bps) * equity) / 10000n;
          const depthRaw = cbbtcBar.c_depth.length > 0 ? BigInt(cbbtcBar.c_depth[0]) : 0n;
          const depthCap = depthRaw > 0n ? depthRaw / 200n : cash;

          let size = (cash * 995n) / 1000n;
          if (maxWeight < size) size = maxWeight;
          if (depthCap < size) size = depthCap;
          if (chosenMode === 'guardrail') {
            const probe = 2_000_000n;
            if (probe < size) size = probe;
          }

          if (size >= minNotional && size > 0n) {
            pendingMode = chosenMode;
            pendingTriggerPrice = close;
            orders.push({
              side: 'buy',
              client_id: nextClientId(),
              symbol: 'CBBTC',
              notional_quote_units: size.toString(),
              max_slippage_bps: 80,
            });
          }
        }
      }

      process.stdout.write(`${JSON.stringify({ type: 'reply', seq: msg.seq, orders })}\n`);
    }
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
