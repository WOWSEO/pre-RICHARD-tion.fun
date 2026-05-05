import type {
  Market,
  Position,
  TradeEvent,
  User,
} from "../market/marketTypes";

/**
 * In-memory store for the brain POC. No persistence.
 *
 * Replace with a Postgres / SQLite layer in a follow-up phase. The schema is
 * documented in the prior research report §8.
 */
export class MemoryStore {
  users: User[] = [];
  markets: Market[] = [];

  upsertUser(wallet: string, openingBalance: number): User {
    const existing = this.users.find((u) => u.wallet === wallet);
    if (existing) return existing;
    const u: User = { wallet, trollBalance: openingBalance };
    this.users.push(u);
    return u;
  }

  addMarket(m: Market): Market {
    this.markets.push(m);
    return m;
  }

  getMarket(id: string): Market {
    const m = this.markets.find((mm) => mm.id === id);
    if (!m) throw new Error(`market not found: ${id}`);
    return m;
  }

  getUser(wallet: string): User {
    const u = this.users.find((uu) => uu.wallet === wallet);
    if (!u) throw new Error(`user not found: ${wallet}`);
    return u;
  }

  /** All positions across all markets for a wallet. */
  getUserPositions(wallet: string): Position[] {
    return this.markets.flatMap((m) =>
      m.positions.filter((p) => p.wallet === wallet),
    );
  }

  /** Trade history across all markets for a wallet, in chronological order. */
  getUserTradeHistory(wallet: string): TradeEvent[] {
    const all = this.markets.flatMap((m) =>
      m.trades.filter((t) => t.wallet === wallet),
    );
    return all.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}
