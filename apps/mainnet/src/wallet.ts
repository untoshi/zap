#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import fetch from 'node-fetch';
import { bech32, bech32m } from 'bech32';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { CONFIG } from './config.js';

async function initWallet() {
  let mnemonic = CONFIG.mnemonic;
  if (!mnemonic) {
    mnemonic = bip39.generateMnemonic(256);
    console.log(chalk.yellow('Generated new BIP39 mnemonic:'));
    console.log(chalk.greenBright(mnemonic));
    console.log(chalk.yellow('Save this securely. It controls your funds.'));
  }

  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network: CONFIG.network },
  });

  const pub = await wallet.getIdentityPublicKey();
  const addr = await wallet.getSparkAddress();
  console.log(chalk.gray(`Wallet initialized for ${CONFIG.network}`));
  console.log(`identityPubKey: ${pub}`);
  console.log(`sparkAddress: ${addr}`);

  // Also show an L1 Taproot deposit address for funding
  try {
    const mode = CONFIG.depositMode.toLowerCase();
    if (mode === 'static') {
      const taproot = await wallet.getStaticDepositAddress();
      console.log(`taprootDepositAddress (static): ${taproot}`);
    } else {
      const taproot = await wallet.getSingleUseDepositAddress();
      console.log(`taprootDepositAddress (single-use): ${taproot}`);
    }
    console.log(chalk.gray('Send BTC to the taproot deposit address to fund your Spark wallet, then run:' ));
    console.log(chalk.gray('  npm run wallet:watch-claim   # auto-claim L1 deposit onto Spark'));
  } catch (e) {
    console.log(chalk.yellow(`Could not fetch taproot deposit address: ${(e as any)?.message || e}`));
  }
}

async function printAddress() {
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });
  // Always print Spark address and both deposit types for convenience
  const sparkAddress = await wallet.getSparkAddress();
  console.log(`Spark address: ${sparkAddress}`);
  try {
    const staticAddr = await wallet.getStaticDepositAddress();
    console.log(`Static Taproot deposit: ${staticAddr}`);
  } catch (e) {
    console.log(chalk.yellow(`Static deposit unavailable: ${(e as any)?.message || e}`));
  }
  try {
    const singleUseAddr = await wallet.getSingleUseDepositAddress();
    console.log(`Single-use Taproot deposit: ${singleUseAddr}`);
  } catch (e) {
    console.log(chalk.yellow(`Single-use deposit unavailable: ${(e as any)?.message || e}`));
  }
}

async function printBalance() {
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });
  try {
    // Attempt to use FlashnetClient via dynamic import to avoid changing deps here
    const { FlashnetClient } = await import('@flashnet/sdk');
    const client: any = new (FlashnetClient as any)(wallet, { autoAuthenticate: true } as any);
    await client.initialize();
    const bal: any = await client.getBalance();
    console.log(`BTC: ${bal.balance ?? 0} sats`);
    const tb: any = bal.tokenBalances;
    const entries: Array<[string, any]> = tb instanceof Map ? Array.from(tb.entries()) : tb ? Object.entries(tb) : [];
    if (!entries.length) { console.log('Tokens: none'); return; }

    const apiKey = process.env.SPARKSCAN_API_KEY || '';
    const metaByHex: Record<string, { ticker?: string; name?: string; decimals?: number }> = {};
    const cacheFile = path.join(process.cwd(), `.tokens-cache.${String(CONFIG.network).toLowerCase()}.json`);
    const loadCache = async (): Promise<Record<string, any>> => { try { const txt = await fsp.readFile(cacheFile, 'utf-8'); return JSON.parse(txt || '{}') || {}; } catch { return {}; } };
    const saveCache = async (obj: Record<string, any>) => { try { await fsp.writeFile(cacheFile, JSON.stringify(obj, null, 2) + '\n'); } catch {} };
    if (apiKey) {
      try {
        const toHex = (addr: string): string | null => {
          try { const d = bech32m.decode(addr); return Buffer.from(bech32.fromWords(d.words)).toString('hex'); } catch {}
          try { const d = bech32.decode(addr); return Buffer.from(bech32.fromWords(d.words)).toString('hex'); } catch {}
          if (/^[0-9a-fA-F]{66}$/.test(addr)) return addr.toLowerCase();
          return null;
        };
        const hexes = entries.map(([a]) => toHex(a)).filter((x): x is string => !!x);
        const needed = Array.from(new Set(hexes));
        const cache = await loadCache();
        for (const h of needed) { if (cache[h]) metaByHex[h] = cache[h]; }
        const missing = needed.filter((h) => !metaByHex[h]);
        if (missing.length) {
          const url = `https://api.sparkscan.io/v1/tokens/metadata/batch?network=${CONFIG.network}`;
          const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ token_addresses: missing }) });
          if (resp.ok) {
            const data: any = await resp.json();
            const list: any[] = data?.metadata || [];
            for (const m of list) {
              const key = (m?.tokenAddress || m?.address || m?.id || '').toLowerCase();
              const meta = m?.metadata || m;
              const item = { ticker: meta?.ticker || meta?.symbol || meta?.tickerSymbol, name: meta?.name, decimals: Number(meta?.decimals ?? meta?.precision ?? 0) || undefined };
              if (key) { metaByHex[key] = item; cache[key] = item; }
            }
            await saveCache(cache);
          }
        }
      } catch {}
    }

    const formatUnits = (v: any, decimals?: number): string => {
      const raw = (typeof v === 'bigint') ? v.toString() : (v?.toString ? v.toString() : String(v));
      if (!decimals || !/^\d+$/.test(raw)) return raw;
      const s = raw;
      if (decimals === 0) return s;
      const pad = s.padStart(decimals + 1, '0');
      const int = pad.slice(0, -decimals) || '0';
      let frac = pad.slice(-decimals);
      frac = frac.replace(/0+$/, '');
      return frac ? `${int}.${frac}` : int;
    };

    console.log('Tokens:');
    for (const [tokenAddr, amount] of entries) {
      const hex = (() => {
        try { const d = bech32m.decode(tokenAddr); return Buffer.from(bech32.fromWords(d.words)).toString('hex'); } catch {}
        try { const d = bech32.decode(tokenAddr); return Buffer.from(bech32.fromWords(d.words)).toString('hex'); } catch {}
        if (/^[0-9a-fA-F]{66}$/.test(tokenAddr)) return tokenAddr.toLowerCase();
        return undefined;
      })();
      const meta = hex ? metaByHex[hex] : undefined;
      // Prefer embedded tokenInfo when available
      let decimals: number | undefined = meta?.decimals;
      let label: string = meta?.ticker || meta?.name || tokenAddr;
      if (amount && typeof amount === 'object') {
        const ti: any = (amount as any).tokenInfo;
        if (ti) {
          if (decimals == null && ti.tokenDecimals != null) decimals = Number(ti.tokenDecimals) || undefined;
          if (label === tokenAddr) label = ti.tokenSymbol || ti.tokenName || label;
        }
      }
      const value = (amount && typeof amount === 'object' && (amount as any).balance != null)
        ? (amount as any).balance
        : ((amount && typeof amount === 'object' && 'amount' in (amount as any)) ? (amount as any).amount : amount);
      const amt = formatUnits(value, decimals);
      console.log(`- ${label}: ${amt}`);
    }
  } catch {
    const bal = await wallet.getBalance();
    console.log(`BTC: ${bal.balance} sats`);
    if ((bal as any).tokenBalances?.size) {
      console.log(`Tokens: ${(bal as any).tokenBalances.size}`);
    }
  }
}

async function watchClaim() {
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });

  // If a txid is provided via env (BITCOIN_TXID), claim directly without watching
  const envTxid = process.env.BITCOIN_TXID?.trim();
  if (envTxid) {
    console.log(chalk.gray(`Attempting to claim deposit txid=${envTxid}...`));
    try {
      const w: any = wallet as any;
      const txid = envTxid;
      const tryCalls: Array<{ m: string, args: any[] }> = [
        // Try simplest forms first (no explicit fee)
        { m: 'claimDeposit', args: [txid] },
        { m: 'claimDeposit', args: [{ transactionId: txid }] },
        { m: 'claimStaticDeposit', args: [txid] },
        { m: 'claimStaticDeposit', args: [{ transactionId: txid }] },
        { m: 'claimTaprootDeposit', args: [txid] },
        { m: 'claimTaprootDeposit', args: [{ transactionId: txid }] },
        // Then variants with max fee if required by implementation
        { m: 'claimDeposit', args: [txid, CONFIG.claimMaxFee] },
        { m: 'claimDeposit', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
        { m: 'claimStaticDepositWithMaxFee', args: [txid, CONFIG.claimMaxFee] },
        { m: 'claimStaticDepositWithMaxFee', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
        { m: 'claimTaprootDepositWithMaxFee', args: [txid, CONFIG.claimMaxFee] },
        { m: 'claimTaprootDepositWithMaxFee', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
      ];
      let ok = false; let lastErr: any;
      for (const { m, args } of tryCalls) {
        if (typeof w[m] !== 'function') continue;
        try { const res = await w[m](...args); console.log(chalk.green(`Claimed via ${m}`)); ok = true; break; } catch (err) { lastErr = err; }
      }
      if (!ok) throw lastErr || new Error('No compatible claim method');
    } catch (e) {
      console.error(chalk.red('Claim failed:'), (e as any)?.message || e);
    }
    return;
  }

  // Otherwise, watch for a new deposit to the static address and claim it
  function mempoolApiBase(): string {
    const net = String(CONFIG.network).toUpperCase();
    if (net === 'TESTNET') return 'https://mempool.space/testnet/api';
    if (net === 'SIGNET') return 'https://mempool.space/signet/api';
    return 'https://mempool.space/api';
  }

  const addr = await wallet.getStaticDepositAddress();
  console.log(chalk.gray(`Watching mempool for deposits to: ${addr}`));

  async function mempoolLatestTx(address: string): Promise<string | null> {
    try {
      const url = `${mempoolApiBase()}/address/${address}/txs`;
      const res = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (!res.ok) return null;
      const arr = await res.json() as any[];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr[0]?.txid || null;
    } catch {
      return null;
    }
  }

  const deadline = Date.now() + 10 * 60 * 1000; // 10 minutes
  let txid: string | null = null;
  while (Date.now() < deadline && !txid) {
    txid = await mempoolLatestTx(addr);
    if (txid) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!txid) {
    console.log(chalk.yellow('No deposit detected within timeout. You can retry or claim manually.'));
    return;
  }

  // Wait for required confirmations before claiming (mainnet/testnet)
  async function getConfirmations(t: string): Promise<number> {
    try {
      const base = mempoolApiBase();
      const statusUrl = `${base}/tx/${t}/status`;
      const tipUrl = `${base}/blocks/tip/height`;
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
  const needed = CONFIG.claimMinConfirmations || 3;
  let confs = 0;
  while (confs < needed) {
    confs = await getConfirmations(txid);
    process.stdout.write(`\rWaiting for confirmations: ${confs}/${needed}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  process.stdout.write('\n');

  console.log(chalk.gray(`Attempting to claim txid: ${txid} (confirmations=${confs})`));
  try {
    const w: any = wallet as any;
    const tryCalls: Array<{ m: string, args: any[] }> = [
      { m: 'claimDeposit', args: [txid] },
      { m: 'claimDeposit', args: [{ transactionId: txid }] },
      { m: 'claimStaticDeposit', args: [txid] },
      { m: 'claimStaticDeposit', args: [{ transactionId: txid }] },
      { m: 'claimTaprootDeposit', args: [txid] },
      { m: 'claimTaprootDeposit', args: [{ transactionId: txid }] },
      // Fee-bearing variants last
      { m: 'claimDeposit', args: [txid, CONFIG.claimMaxFee] },
      { m: 'claimDeposit', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
      { m: 'claimStaticDepositWithMaxFee', args: [txid, CONFIG.claimMaxFee] },
      { m: 'claimStaticDepositWithMaxFee', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
      { m: 'claimTaprootDepositWithMaxFee', args: [txid, CONFIG.claimMaxFee] },
      { m: 'claimTaprootDepositWithMaxFee', args: [{ transactionId: txid, maxFee: CONFIG.claimMaxFee }] },
    ];
    let ok = false; let lastErr: any;
    for (const { m, args } of tryCalls) {
      if (typeof w[m] !== 'function') continue;
      try { const res = await w[m](...args); console.log(chalk.green(`Claimed via ${m}`)); ok = true; break; } catch (err) { lastErr = err; }
    }
    if (!ok) throw lastErr || new Error('No compatible claim method');
  } catch (e) {
    console.error(chalk.red('Claim failed:'), (e as any)?.message || e);
  }
}

async function main() {
  const cmd = process.argv[2] || '';
  if (!cmd || ['init', 'address', 'balance', 'watch-claim'].indexOf(cmd) === -1) {
    console.log('Usage: wallet.ts <init|address|balance|watch-claim>');
    process.exit(1);
  }
  if (cmd !== 'init' && !CONFIG.mnemonic) {
    console.error('Set MNEMONIC in .env (or run wallet:init to generate)');
    process.exit(1);
  }
  switch (cmd) {
    case 'init':
      await initWallet();
      break;
    case 'address':
      await printAddress();
      break;
    case 'balance':
      await printBalance();
      break;
    case 'watch-claim':
      await watchClaim();
      break;
  }
}

main().catch((err) => {
  console.error(chalk.red('wallet error:'), err?.message || err);
  process.exit(1);
});
