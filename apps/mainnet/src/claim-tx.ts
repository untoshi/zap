#!/usr/bin/env ts-node
import 'dotenv/config';
import fetch from 'node-fetch';
import { SparkWallet } from '@buildonspark/spark-sdk';
import type { Network } from './config.js';

function envStr(name: string, def?: string): string | undefined {
  const v = process.env[name];
  if (v && v.trim() !== '') return v.trim();
  return def;
}

function envNum(name: string, def?: number): number {
  const v = envStr(name);
  if (v == null) return def ?? 2000;
  const n = Number(v);
  return Number.isFinite(n) ? n : (def ?? 2000);
}

function apiBase(network: string) {
  const net = String(network).toUpperCase();
  if (net === 'TESTNET') return 'https://mempool.space/testnet/api';
  if (net === 'SIGNET') return 'https://mempool.space/signet/api';
  return 'https://mempool.space/api';
}

async function getTxHex(base: string, txid: string): Promise<string | null> {
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
  const network = (envStr('DEFAULT_NETWORK', 'MAINNET') || 'MAINNET').toUpperCase() as Network;
  const argv = process.argv.slice(2);
  const nonFlags = argv.filter((a) => !a.startsWith('-'));
  const txArg = nonFlags[0];
  const voutArgCli = nonFlags.length > 1 ? Number(nonFlags[1]) : undefined;
  const txInput = envStr('BITCOIN_TXID') || txArg || '';
  const voutEnv = envStr('BITCOIN_VOUT');
  const voutArg = voutEnv != null && voutEnv !== '' ? Number(voutEnv) : voutArgCli;
  if (!txInput) { console.error('Provide txid/hex via arg or BITCOIN_TXID'); process.exit(1); }
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: envStr('MNEMONIC')!, options: { network } });
  const w: any = wallet as any;

  const isHex = /^[0-9a-fA-F]{200,}$/.test(txInput);
  const base = apiBase(network);
  let txHex = isHex ? txInput : (await getTxHex(base, txInput)) || null;
  if (txHex && !/^[0-9a-fA-F]+$/.test(txHex)) txHex = null;

  const maxFee = envNum('CLAIM_MAX_FEE', 2000);
  const tryCalls: Array<{ m: string, args: any[] }> = [
    { m: 'claimDeposit', args: [txInput] },
  ];

  let ok = false; let used: string | null = null; let lastErr: any;
  for (const { m, args } of tryCalls) {
    if (typeof w[m] !== 'function') continue;
    try { await w[m](...args); ok = true; used = m; break; } catch (err) { lastErr = err; }
  }

  const result = ok ? { success: true, method: used, tx: txInput } : { success: false, error: (lastErr as any)?.message || String(lastErr || 'Unknown error') };
  process.stdout.write(JSON.stringify(result, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
