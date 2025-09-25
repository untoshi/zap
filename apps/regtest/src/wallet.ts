#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import fetch from 'node-fetch';
import { bech32, bech32m } from 'bech32';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { FlashnetClient } from '@flashnet/sdk';
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
  const sparkAddr = await wallet.getSparkAddress();
  console.log(chalk.gray(`Wallet initialized for ${CONFIG.network}`));
  console.log(`identityPubKey: ${pub}`);
  console.log(`sparkAddress: ${sparkAddr}`);
  try {
    const staticAddr = await wallet.getStaticDepositAddress();
    console.log(`staticDepositAddress: ${staticAddr}`);
  } catch {}
  try {
    const singleUse = await wallet.getSingleUseDepositAddress();
    console.log(`singleUseDepositAddress: ${singleUse}`);
  } catch {}
}

async function printAddress() {
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });
  const sparkAddress = await wallet.getSparkAddress();
  console.log(`Spark address: ${sparkAddress}`);
  try { console.log(`Static Taproot deposit: ${await wallet.getStaticDepositAddress()}`); } catch {}
  try { console.log(`Single-use Taproot deposit: ${await wallet.getSingleUseDepositAddress()}`); } catch {}
}

async function printBalance() {
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });
  try {
    // Prefer FlashnetClient to include token balances
    const client = new FlashnetClient(wallet, { autoAuthenticate: true } as any);
    const t0 = Date.now();
    await client.initialize();
    const initMs = Date.now() - t0;
    const t1 = Date.now();
    const bal: any = await client.getBalance();
    const balMs = Date.now() - t1;
    console.log(`BTC: ${bal.balance ?? 0} sats`);
    const tb: any = bal.tokenBalances;
    const entries: Array<[string, any]> = tb instanceof Map ? Array.from(tb.entries()) : tb ? Object.entries(tb) : [];
    if (!entries.length) { if (process.env.DEBUG_BAL === '1') console.log(`DEBUG: initMs=${initMs}ms balMs=${balMs}ms tokenEntries=0`); console.log('Tokens: none'); return; }
    if (process.env.DEBUG_BAL === '1') {
      console.log(`DEBUG: initMs=${initMs}ms balMs=${balMs}ms tokenEntries=${entries.length}`);
      try {
        const safe = (v: any) => { try { return JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val); } catch { return String(v); } };
        console.log(`DEBUG: sampleTokenEntry.key=${String(entries[0]?.[0])}`);
        console.log(`DEBUG: sampleTokenEntry.val.keys=${entries[0] && typeof entries[0][1] === 'object' ? Object.keys(entries[0][1] as any).join(',') : typeof entries[0]?.[1]}`);
        console.log(`DEBUG: sampleTokenEntry.val=${safe(entries[0]?.[1])}`);
      } catch {}
    }

    // Optional: resolve token metadata from Sparkscan if API key available
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
          const tMeta0 = Date.now();
          const url = `https://api.sparkscan.io/v1/tokens/metadata/batch?network=${CONFIG.network}`;
          const resp = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ token_addresses: missing }),
          });
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
            const metaMs = Date.now() - tMeta0;
            if (process.env.DEBUG_BAL === '1') console.log(`DEBUG: sparkscan meta fetched for=${list.length} metaMs=${metaMs}ms (cached ${needed.length - missing.length} / total ${needed.length})`);
          } else {
            if (process.env.DEBUG_BAL === '1') console.log(`DEBUG: sparkscan meta fetch failed status=${resp.status}`);
          }
        } else if (process.env.DEBUG_BAL === '1') {
          console.log('DEBUG: sparkscan cache hit for all tokens');
        }
      } catch (err) {
        if (process.env.DEBUG_BAL === '1') console.log(`DEBUG: sparkscan error: ${(err as any)?.message || err}`);
      }
    } else {
      if (process.env.DEBUG_BAL === '1') console.log('DEBUG: SPARKSCAN_API_KEY not set; skipping metadata');
    }

    const normalizeAmount = (v: any): string => {
      if (v == null) return '0';
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object') {
        // Try common fields first
        const cand = (v as any).amount ?? (v as any).value ?? (v as any).val ?? (v as any).n ?? (v as any).sats;
        if (cand != null) return normalizeAmount(cand);
        // Try methods or encodings
        if (typeof (v as any).toNumber === 'function') {
          try { return String((v as any).toNumber()); } catch {}
        }
        if (typeof (v as any).toBigInt === 'function') {
          try { return ((v as any).toBigInt() as bigint).toString(); } catch {}
        }
        if (typeof (v as any).toJSON === 'function') {
          try { const j = (v as any).toJSON(); if (j != null) return normalizeAmount(j); } catch {}
        }
        const hex = (v as any)._hex || (v as any).hex;
        if (typeof hex === 'string') {
          try { return BigInt(hex).toString(); } catch {}
        }
        if (typeof (v as any).toString === 'function') {
          const s = (v as any).toString();
          if (s && s !== '[object Object]') return s;
        }
        try { return JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val); } catch { return String(v); }
      }
      return String(v);
    };
    const formatUnits = (v: any, decimals?: number): string => {
      const raw = normalizeAmount(v);
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
      const rawVal = (amount && typeof amount === 'object' && (amount as any).balance != null)
        ? (amount as any).balance
        : amount;
      const amt = formatUnits(rawVal, decimals);
      console.log(`- ${label}: ${amt}`);
    }
  } catch (e) {
    // Fallback to Spark wallet balance if Flashnet client isn't available
    const bal = await wallet.getBalance();
    console.log(`BTC: ${bal.balance} sats`);
  }
}

async function watchClaim() {
  if (!CONFIG.txid) {
    console.log(chalk.yellow('Set BITCOIN_TXID in .env to claim your regtest deposit.'));
    process.exit(1);
  }
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: CONFIG.mnemonic!,
    options: { network: CONFIG.network },
  });
  console.log(chalk.gray(`Attempting to claim deposit txid=${CONFIG.txid}...`));
  try {
    const w: any = wallet as any;
    const txid = CONFIG.txid!;
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
}

async function main() {
  const cmd = process.argv[2] || '';
  if (!cmd || !['init','address','balance','watch-claim'].includes(cmd)) {
    console.log('Usage: wallet.ts <init|address|balance|watch-claim>');
    process.exit(1);
  }
  if (cmd !== 'init' && !CONFIG.mnemonic) {
    console.error('Set MNEMONIC in .env (or run wallet:init to generate)');
    process.exit(1);
  }
  if (cmd === 'init') return initWallet();
  if (cmd === 'address') return printAddress();
  if (cmd === 'balance') return printBalance();
  if (cmd === 'watch-claim') return watchClaim();
}

main().catch((err) => {
  console.error(chalk.red('wallet error:'), err?.message || err);
  process.exit(1);
});
