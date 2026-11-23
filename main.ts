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

async function run(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let hello: HelloMsg | null = null;
  const history: BarData[] = [];

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const msg = JSON.parse(line) as HelloMsg | BatchMsg | DoneMsg;

    if (msg.type === 'hello') {
      hello = msg;
      continue;
    }

    if (msg.type === 'done') {
      break;
    }

    if (msg.type === 'batch') {
      if (hello === null) {
        throw new Error('Received batch before hello');
      }
      for (const bar of msg.bars) {
        if (bar.symbol === 'CBBTC') {
          history.push(bar);
        }
      }
      const orders: OrderMsg[] = [];
      process.stdout.write(`${JSON.stringify({ type: 'reply', seq: msg.seq, orders })}\n`);
    }
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
