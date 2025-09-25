#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import fetch from 'node-fetch';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { CONFIG } from './config.js';

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function apiBase() {
  const env = (process.env.MEMPOOL_API_BASE || '').trim();
  if (env) return env.replace(/\/$/, '');
  // Auto-select mempool API by network when not provided via env
  const net = String(CONFIG.network).toUpperCase();
  if (net === 'TESTNET') return 'https://mempool.space/testnet/api';
  if (net === 'SIGNET') return 'https://mempool.space/signet/api';
  return 'https://mempool.space/api';
}

async function listAddressTxids(addr: string): Promise<string[]> {
  const url = `${apiBase()}/address/${addr}/txs`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return [];
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr)) return [];
  return arr.map((t: any) => t?.txid).filter((x: any) => typeof x === 'string');
}

async function getConfirmations(txid: string): Promise<number> {
  try {
    const statusUrl = `${apiBase()}/tx/${txid}/status`;
    const tipUrl = `${apiBase()}/blocks/tip/height`;
    const [statusRes, tipRes] = await Promise.all([
      fetch(statusUrl, { headers: { 'accept': 'application/json' } }),
      fetch(tipUrl, { headers: { 'accept': 'application/json' } }),
    ]);
    if (!statusRes.ok || !tipRes.ok) return 0;
    const status = await statusRes.json() as any;
    const tipHeight = Number(await tipRes.text());
    if (!status?.confirmed) return 0;
    const bh = Number(status?.block_height ?? 0);
    if (!Number.isFinite(bh) || !Number.isFinite(tipHeight) || bh <= 0) return 0;
    return Math.max(0, tipHeight - bh + 1);
  } catch { return 0; }
}

async function getTxHex(txid: string): Promise<string | null> {
  const base = apiBase();
  const candidates = [
    `${base}/tx/${txid}/hex`,
    `${base}/tx/${txid}/raw`,
    `${base}/rawtx/${txid}`,
    `${base}/raw/tx/${txid}`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { accept: 'text/plain' } });
      const txt = await res.text();
      if (!res.ok) continue;
      const hex = txt.trim();
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length > 100) return hex;
    } catch {}
  }
  try {
    const res = await fetch(`${base}/tx/${txid}`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const j: any = await res.json();
      const hex = (j && (j.hex || j.raw || j.txHex))?.toString?.();
      if (hex && /^[0-9a-fA-F]+$/.test(hex)) return hex;
    }
  } catch {}
  return null;
}

async function main() {
  const label = process.env.WATCHER_NAME ? `[${process.env.WATCHER_NAME}] ` : '';
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });
  try {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(wallet));
    console.log(chalk.gray(`${label}DEBUG: wallet methods: ${proto.filter(k => k.toLowerCase().includes('claim')).join(', ')}`));
  } catch {}
  const addrs: string[] = [];
  const staticAddr = await wallet.getStaticDepositAddress(); addrs.push(staticAddr);
  let singleUse: string | null = null;
  // Single-use disabled for now to avoid confusion
  // try { singleUse = await wallet.getSingleUseDepositAddress(); if (singleUse) addrs.push(singleUse); } catch {}
  console.log(chalk.cyan(`${label}Auto-claim watcher — ${CONFIG.network}`));
  console.log(chalk.gray(`${label}Watching deposit addresses:`));
  console.log(chalk.gray(`  static:     ${staticAddr}`));

  // Prefer SDK's built-in periodic claim loop if available
  const w: any = wallet as any;
  if (typeof w.startPeriodicClaimTransfers === 'function') {
    const tries = [
      [], [{}],
      [{ intervalMs: 10000 }],
      [{ pollIntervalMs: 10000 }],
      [{ maxFee: CONFIG.claimMaxFee }],
      [{ intervalMs: 10000, maxFee: CONFIG.claimMaxFee }],
      [{ pollIntervalMs: 10000, maxFee: CONFIG.claimMaxFee }],
    ];
    let started = false; let lastErr: any;
    for (const args of tries) {
      try { await w.startPeriodicClaimTransfers(...args as any); started = true; break; } catch (e) { lastErr = e; }
    }
    if (started) {
      console.log(chalk.green(`${label}SDK periodic auto-claim active (10s). New deposits will be claimed automatically after confirmations.`));
      while (true) { await sleep(60_000); }
    } else {
      console.log(chalk.yellow(`${label}Could not start SDK periodic auto-claim: ${(lastErr as any)?.message || lastErr}. Falling back to explorer polling.`));
    }
  }
  const seen = new Set<string>();
  const minConf = Number(CONFIG.claimMinConfirmations || 3);

  while (true) {
    try {
      let txids: string[] = [];
      for (const a of addrs) {
        const xs = await listAddressTxids(a);
        for (const x of xs) if (!txids.includes(x)) txids.push(x);
      }
      for (const txid of txids) {
        if (seen.has(txid)) continue;
        seen.add(txid);
        console.log(chalk.gray(`${label}Detected deposit tx: ${txid} — waiting for ${minConf} confs`));
        let confs = 0;
        while (confs < minConf) {
          confs = await getConfirmations(txid);
          process.stdout.write(`\rConfirmations: ${confs}/${minConf}`);
          await sleep(10_000);
        }
        process.stdout.write('\n');
        console.log(chalk.gray(`${label}Claiming ${txid} (maxFee=${CONFIG.claimMaxFee})`));
        const txHex = await getTxHex(txid);
        try {
          const w: any = wallet as any;
          const tryCalls: Array<{ m: string, args: any[] }> = [
            // Prefer simple calls without explicit fee first
            { m: 'claimDeposit', args: [txHex] },
            { m: 'claimDeposit', args: [{ txHex }] },
            { m: 'claimStaticDeposit', args: [txHex] },
            { m: 'claimStaticDeposit', args: [{ txHex }] },
            { m: 'claimTaprootDeposit', args: [txHex] },
            { m: 'claimTaprootDeposit', args: [{ txHex }] },
            // Then with fee if required by implementation
            { m: 'claimDeposit', args: [txHex, CONFIG.claimMaxFee] },
            { m: 'claimDeposit', args: [{ txHex, maxFee: CONFIG.claimMaxFee }] },
            { m: 'claimStaticDepositWithMaxFee', args: [txHex, CONFIG.claimMaxFee] },
            { m: 'claimStaticDepositWithMaxFee', args: [{ txHex, maxFee: CONFIG.claimMaxFee }] },
            { m: 'claimTaprootDepositWithMaxFee', args: [txHex, CONFIG.claimMaxFee] },
            { m: 'claimTaprootDepositWithMaxFee', args: [{ txHex, maxFee: CONFIG.claimMaxFee }] },
            // Fall back to txid-based
            { m: 'claimStaticDeposit', args: [txid] },
            { m: 'claimStaticDeposit', args: [{ transactionId: txid }] },
            { m: 'claimTaprootDeposit', args: [txid] },
            { m: 'claimTaprootDeposit', args: [{ transactionId: txid }] },
            { m: 'claimDeposit', args: [txid] },
            { m: 'claimDeposit', args: [{ transactionId: txid }] },
            { m: 'claimStaticDepositWithMaxFee', args: [txid, CONFIG.claimMaxFee] },
            { m: 'claimStaticDepositWithMaxFee', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
            { m: 'claimTaprootDepositWithMaxFee', args: [txid, CONFIG.claimMaxFee] },
            { m: 'claimTaprootDepositWithMaxFee', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
          ].filter(x => x.args.every(a => a !== undefined && a !== null));
          let ok = false; let lastErr: any;
          for (const { m, args } of tryCalls) {
            if (typeof w[m] !== 'function') continue;
            try { const res = await w[m](...args); console.log(chalk.green(`${label}Claimed ${txid} via ${m}`)); ok = true; break; } catch (err) { lastErr = err; }
          }
          if (!ok) throw lastErr || new Error('No compatible claim method');
        } catch (e) {
          console.log(chalk.red(`${label}Claim failed for ${txid}: ${(e as any)?.message || e}`));
        }
      }
    } catch (e) {
      console.log(chalk.yellow(`${label}watch error: ${(e as any)?.message || e}`));
    }
    await sleep(5000);
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
