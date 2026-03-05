import type { ClobClient } from '@polymarket/clob-client';
import type { RuntimeEnv } from '../config/env';
import type { Logger } from '../utils/logger';
import { getMyPortfolio } from '../utils/getMyBalance';
import { getTraderPortfolio } from '../utils/getTraderBalance';
import WebSocket from 'ws';

const DATA_API = 'https://data-api.polymarket.com';
const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';

// Fallback polling interval — catches anything RTDS misses
const POLL_INTERVAL_MS = 10_000;

// RTDS constants
const PING_INTERVAL_MS = 5_000;
const RTDS_RECONNECT_INTERVAL_MS = 5 * 60 * 1000;
const WATCHDOG_TIMEOUT_MS = 15_000;

function shortAddr(address: string): string {
  return address.slice(0, 8);
}

type RtdsTrade = {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  outcome: string;
  outcomeIndex: number;
  title: string;
  transactionHash: string;
  status?: string;
};

type DataApiTrade = {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  title: string;
};

export type TradeSignal = {
  traderAddress: string;
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
  txHash: string;
  marketTitle: string;
};

export type TradeMonitorDeps = {
  client: ClobClient;
  env: RuntimeEnv;
  logger: Logger;
  userAddresses: string[];
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

export class TradeMonitor {
  private readonly deps: TradeMonitorDeps;
  private readonly watchedAddresses = new Set<string>();

  // Shared dedup set — used by both RTDS and polling paths
  private readonly seenTxHashes = new Set<string>();

  // Per-trader signal queues. Each trader has an ordered queue of signals waiting
  // to be executed, and a boolean indicating whether a signal is currently running.
  // This replaces the old pendingFire set, which would permanently drop any signal
  // that arrived while another was executing for the same trader.
  private readonly traderQueues = new Map<string, TradeSignal[]>();
  private readonly traderRunning = new Set<string>();

  // RTDS state
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private lastMessageAt: number = Date.now();
  private isConnecting: boolean = false;
  private reconnectDelay: number = 10_000;

  // Polling state
  private pollTimer?: NodeJS.Timeout;

  constructor(deps: TradeMonitorDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    const { logger, env, client } = this.deps;

    logger.info('========================================');
    logger.info('  Polymarket Copy Trading Bot — STARTUP ');
    logger.info('========================================');
    logger.info(
      `Watching ${this.deps.userAddresses.length} trader(s) | RTDS (fast) + polling every ${POLL_INTERVAL_MS / 1000}s (reliable fallback)`,
    );

    logger.info('----------------------------------------');
    logger.info('BOT WALLET (your portfolio):');
    try {
      const mine = await getMyPortfolio(client as any, env.proxyWallet, env.rpcUrl);
      logger.info(`  Proxy wallet : ${mine.proxyWallet}`);
      logger.info(
        `  Portfolio    : $${mine.total.toFixed(2)}  |  Invested: $${mine.invested.toFixed(2)}  |  Cash: $${mine.cash.toFixed(2)}`,
      );
    } catch (e) {
      logger.warn(`  Could not fetch own portfolio: ${(e as Error).message}`);
    }

    for (const address of this.deps.userAddresses) {
      const lowerAddr = address.toLowerCase();
      this.watchedAddresses.add(lowerAddr);

      logger.info('----------------------------------------');
      logger.info(`COPYING TRADER: ${address}`);
      logger.info(`  Profile: https://polymarket.com/profile/${address}`);

      try {
        const trader = await getTraderPortfolio(address, env.rpcUrl);
        logger.info(
          `  Portfolio: $${trader.total.toFixed(2)}  |  Invested: $${trader.invested.toFixed(2)}  |  Cash: $${trader.cash.toFixed(2)}`,
        );
      } catch (e) {
        logger.warn(`  Could not fetch trader portfolio: ${(e as Error).message}`);
      }

      // Seed recent txHashes so neither RTDS nor polling replays old trades
      try {
        const recentTrades = await this.fetchRecentTrades(address, 20);
        for (const t of recentTrades) {
          this.seenTxHashes.add(this.dedupKey(lowerAddr, t.transactionHash));
        }
        logger.info(`  Seeded ${recentTrades.length} historical trade(s)`);
        if (recentTrades.length > 0) {
          const last = recentTrades[recentTrades.length - 1];
          logger.info(`  Last trade: ${last.side} ${last.outcome} on "${last.title}" @ $${last.price}`);
        } else {
          logger.warn(`  ⚠ No trades found — verify this is the PROXY wallet, not the EOA`);
        }
      } catch (e) {
        logger.warn(`  Could not seed trades: ${(e as Error).message}`);
      }
    }

    logger.info('----------------------------------------');
    logger.info('========================================');

    // Start both paths
    this.connectRtds();
    this.startPolling();
  }

  stop(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.reconnectTimer);
    clearInterval(this.watchdogTimer);
    clearInterval(this.pollTimer);
    this.ws?.terminate();
    this.ws = undefined;
    this.traderQueues.clear();
    this.traderRunning.clear();
  }

  // ── Polling fallback ───────────────────────────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, POLL_INTERVAL_MS);
  }

  private async pollAll(): Promise<void> {
    for (const address of this.deps.userAddresses) {
      try {
        const trades = await this.fetchRecentTrades(address, 10);
        // Sort oldest first so we process in order
        for (const trade of trades) {
          await this.maybeEmit(trade.proxyWallet, {
            proxyWallet: trade.proxyWallet,
            side: trade.side,
            asset: trade.asset,
            conditionId: trade.conditionId,
            size: trade.size,
            price: trade.price,
            outcome: trade.outcome,
            outcomeIndex: trade.outcomeIndex,
            title: trade.title,
            transactionHash: trade.transactionHash,
          }, 'poll');
        }
      } catch (err) {
        this.deps.logger.error(`[poll] Failed to poll trades for ${shortAddr(address)}`, err as Error);
      }
    }
  }

  // ── RTDS WebSocket ─────────────────────────────────────────────────────────

  private connectRtds(): void {
    const { logger } = this.deps;
    if (this.isConnecting) return;
    this.isConnecting = true;

    logger.info(`[rtds] Connecting (backoff: ${this.reconnectDelay / 1000}s)`);
    const ws = new WebSocket(RTDS_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      logger.info('[rtds] Connected');
      this.isConnecting = false;
      this.reconnectDelay = 10_000;
      this.lastMessageAt = Date.now();
      this.subscribe(ws);
      this.startPing(ws);
      this.startRtdsTimers();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString()) as {
          connection_id?: string;
          payload?: unknown;
        };
        if (msg.payload) {
          void this.handleRtdsTrade(msg.payload);
        }
      } catch {
        // malformed frame — ignore
      }
    });

    ws.on('error', (err) => {
      const is429 = (err as Error).message?.includes('429');
      if (is429) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 120_000);
        logger.warn(`[rtds] Rate limited — backing off to ${this.reconnectDelay / 1000}s`);
      } else {
        logger.error('[rtds] Error', err);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'no reason';
      logger.warn(`[rtds] Closed (${code}: ${reasonStr}) — retry in ${this.reconnectDelay / 1000}s`);
      clearInterval(this.pingTimer);
      clearInterval(this.reconnectTimer);
      clearInterval(this.watchdogTimer);
      setTimeout(() => {
        this.isConnecting = false;
        this.connectRtds();
      }, this.reconnectDelay);
    });
  }

  private subscribe(ws: WebSocket): void {
    ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'activity', type: 'trades' }],
    }));
  }

  private startPing(ws: WebSocket): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'PING' }));
      }
    }, PING_INTERVAL_MS);
  }

  private startRtdsTimers(): void {
    const { logger } = this.deps;
    clearInterval(this.reconnectTimer);
    clearInterval(this.watchdogTimer);

    this.reconnectTimer = setInterval(() => {
      if (this.isConnecting) return;
      logger.info('[rtds] Proactive reconnect');
      this.isConnecting = true;
      this.ws?.terminate();
    }, RTDS_RECONNECT_INTERVAL_MS);

    this.watchdogTimer = setInterval(() => {
      if (this.isConnecting) return;
      const silentMs = Date.now() - this.lastMessageAt;
      if (silentMs > WATCHDOG_TIMEOUT_MS) {
        logger.warn(`[rtds] Watchdog — silent for ${Math.round(silentMs / 1000)}s, reconnecting`);
        this.isConnecting = true;
        this.ws?.terminate();
      }
    }, 5_000);
  }

  private async handleRtdsTrade(payload: unknown): Promise<void> {
    const trades: RtdsTrade[] = Array.isArray(payload)
      ? (payload as RtdsTrade[])
      : [payload as RtdsTrade];

    for (const trade of trades) {
      if (!trade?.proxyWallet || !trade?.asset || !trade?.transactionHash) continue;
      if (trade.status && trade.status !== 'MATCHED') continue;
      await this.maybeEmit(trade.proxyWallet, trade, 'rtds');
    }
  }

  // ── Shared emit logic ──────────────────────────────────────────────────────

  private async maybeEmit(
    proxyWallet: string,
    trade: Omit<RtdsTrade, 'status'>,
    source: 'rtds' | 'poll',
  ): Promise<void> {
    const { logger } = this.deps;
    const traderAddr = proxyWallet.toLowerCase();

    if (!this.watchedAddresses.has(traderAddr)) return;

    const dedupKey = this.dedupKey(traderAddr, trade.transactionHash);
    if (this.seenTxHashes.has(dedupKey)) return;

    // Mark as seen immediately so neither RTDS nor polling re-emits this tx.
    this.seenTxHashes.add(dedupKey);

    const sizeUsd = trade.size * trade.price;
    const label = shortAddr(traderAddr);

    logger.info(
      `[${source}] ✅ [${label}] ${trade.side} ${trade.outcome} "${trade.title}" ` +
      `| ${trade.size} shares @ $${trade.price} ($${sizeUsd.toFixed(2)}) ` +
      `| tx: ${trade.transactionHash}`,
    );

    const signal: TradeSignal = {
      traderAddress: proxyWallet,
      marketId: trade.conditionId,
      tokenId: trade.asset,
      outcome: trade.outcomeIndex === 0 ? 'YES' : 'NO',
      side: trade.side,
      sizeUsd,
      price: trade.price,
      timestamp: Math.floor(Date.now() / 1000),
      txHash: trade.transactionHash,
      marketTitle: trade.title,
    };

    // Enqueue signal for this trader and drain sequentially.
    // If another signal is already executing for this trader, this one waits
    // in the queue rather than being dropped.
    if (!this.traderQueues.has(traderAddr)) {
      this.traderQueues.set(traderAddr, []);
    }
    this.traderQueues.get(traderAddr)!.push(signal);

    if (!this.traderRunning.has(traderAddr)) {
      void this.drainQueue(traderAddr, source, label);
    }
  }

  private async drainQueue(traderAddr: string, source: string, label: string): Promise<void> {
    const { logger } = this.deps;
    this.traderRunning.add(traderAddr);

    const queue = this.traderQueues.get(traderAddr)!;
    while (queue.length > 0) {
      const signal = queue.shift()!;
      try {
        await this.deps.onDetectedTrade(signal);
      } catch (err) {
        logger.error(`[${source}] [${label}] onDetectedTrade threw`, err as Error);
      }
    }

    this.traderRunning.delete(traderAddr);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async fetchRecentTrades(traderAddress: string, limit: number): Promise<DataApiTrade[]> {
    const url = `${DATA_API}/trades?user=${traderAddress}&limit=${limit}&takerOnly=false`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Data API ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as DataApiTrade[];
    return data.sort((a, b) => a.timestamp - b.timestamp);
  }

  private dedupKey(traderAddress: string, txHash: string): string {
    return `${traderAddress.toLowerCase()}:${txHash}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}