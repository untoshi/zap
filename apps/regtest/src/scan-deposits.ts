#!/usr/bin/env ts-node
import 'dotenv/config';
import fetch from 'node-fetch';
import { SparkWallet } from '@buildonspark/spark-sdk';
import type { Network } from './config.js';

type Item = { kind: 'static'|'active'; address: string; txid: string; vout: number; value: number; confirmations: number; required: number };

function envStr(name: string, def?: string): string | undefined { const v = process.env[name]; return v && v.trim() !== '' ? v.trim() : def; }
function envNum(name: string, def?: number): number { const v = envStr(name); if (v == null) return def ?? 3; const n = Number(v); return Number.isFinite(n) ? n : (def ?? 3); }
function envBool(name: string, def = false): boolean { const v = envStr(name); if (v == null) return def; return ['1','true','yes','y','on'].includes(v.toLowerCase()); }

function electrsInfo(w: any, network: string): { base: string; headers: Record<string,string> } {
  const base = String(w?.config?.getElectrsUrl?.() || '').replace(/\/$/, '');
  const headers: Record<string,string> = {};
  try {
    if (network.toUpperCase() === 'REGTEST') {
      const creds = w?.config?.lrc20ApiConfig?.electrsCredentials as any;
      if (creds?.username && creds?.password) {
        const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }
    }
  } catch {}
  return { base, headers };
}

function mempoolBase(network: string): string {
  const env = (process.env.MEMPOOL_API_BASE || '').trim();
  if (env) return env.replace(/\/$/, '');
  const net = network.toUpperCase();
  if (net === 'REGTEST') return 'https://mempool.regtest.flashnet.xyz/api';
  if (net === 'TESTNET') return 'https://mempool.space/testnet/api';
  if (net === 'SIGNET') return 'https://mempool.space/signet/api';
  return 'https://mempool.space/api';
}

async function listUtxo(base: string, headers: Record<string,string>, addr: string, fallbackBase?: string): Promise<Array<{ txid: string; vout: number; value: number }>> {
  try {
    const res = await fetch(`${base}/address/${addr}/utxo`, { headers: { accept: 'application/json', ...headers } });
    if (!res.ok) {
      if (fallbackBase) {
        const r2 = await fetch(`${fallbackBase}/address/${addr}/utxo`, { headers: { accept: 'application/json' } });
        if (!r2.ok) return [];
        const arr2 = await r2.json();
        if (!Array.isArray(arr2)) return [];
        return arr2.map((u: any) => ({ txid: String(u?.txid || ''), vout: Number(u?.vout ?? -1), value: Number(u?.value ?? 0) })).filter(u => u.txid && u.vout >= 0);
      }
      return [];
    }
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    return arr.map((u: any) => ({ txid: String(u?.txid || ''), vout: Number(u?.vout ?? -1), value: Number(u?.value ?? 0) })).filter(u => u.txid && u.vout >= 0);
  } catch { return []; }
}

async function getConfs(base: string, headers: Record<string,string>, txid: string): Promise<number> {
  try {
    const st = await fetch(`${base}/tx/${txid}/status`, { headers: { accept: 'application/json', ...headers } });
    const tip = await fetch(`${base}/blocks/tip/height`, { headers: { accept: 'text/plain', ...headers } });
    if (!st.ok || !tip.ok) return 0;
    const s = await st.json() as any; const th = Number(await tip.text());
    if (!s?.confirmed) return 0; const bh = Number(s?.block_height ?? 0);
    if (!(Number.isFinite(bh) && Number.isFinite(th) && bh > 0)) return 0;
    return Math.max(0, th - bh + 1);
  } catch { return 0; }
}

async function listAddressTxs(base: string, headers: Record<string,string>, addr: string): Promise<any[]> {
  try {
    const res = await fetch(`${base}/address/${addr}/txs`, { headers: { accept: 'application/json', ...headers } });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function getOutspends(base: string, headers: Record<string,string>, txid: string): Promise<any[] | null> {
  try {
    const res = await fetch(`${base}/tx/${txid}/outspends`, { headers: { accept: 'application/json', ...headers } });
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

async function main() {
  const network = (envStr('DEFAULT_NETWORK', 'REGTEST') || 'REGTEST').toUpperCase() as Network;
  const mnemonic = envStr('MNEMONIC');
  const required = envNum('CLAIM_MIN_CONFIRMATIONS', 3);
  if (!mnemonic) { console.log(JSON.stringify({ items: [], info: { error: 'MNEMONIC not set' } })); process.exit(0); }

  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  const w: any = wallet as any;
  const { base, headers } = electrsInfo(w, network);
  const fallback = mempoolBase(network);

  let staticAddrs: string[] = [];
  try { staticAddrs = await w.queryStaticDepositAddresses(); } catch {}
  const includeActive = envBool('SCAN_ACTIVE_DEPOSIT_ADDRESSES', false);
  let activeAddrs: string[] = [];
  if (includeActive) {
    try { activeAddrs = await w.getUnusedDepositAddresses(); } catch {}
  }

  const items: Item[] = [];
  // static
  for (const a of staticAddrs) {
    const utxos = await listUtxo(base, headers, a, fallback);
    if (utxos.length) {
      for (const u of utxos) {
        const conf = await getConfs(base, headers, u.txid);
        items.push({ kind: 'static', address: a, txid: u.txid, vout: u.vout, value: u.value, confirmations: conf, required });
      }
    } else {
      const txs = await listAddressTxs(base, headers, a);
      for (const tx of txs) {
        const txid = String(tx?.txid || tx?.hash || ''); if (!txid) continue;
        const outspends = await getOutspends(base, headers, txid);
        const vouts: any[] = Array.isArray(tx?.vout) ? tx.vout : (Array.isArray(tx?.outputs) ? tx.outputs : []);
        for (let i = 0; i < vouts.length; i++) {
          const out = vouts[i];
          const outAddr = out?.scriptpubkey_address || out?.address || out?.scriptPubKey?.address;
          if (outAddr !== a) continue;
          const spent = Array.isArray(outspends) ? Boolean(outspends[i]?.spent) : true;
          if (!spent) {
            const value = Number(out?.value ?? out?.sats ?? 0);
            const conf = await getConfs(base, headers, txid);
            items.push({ kind: 'static', address: a, txid, vout: i, value, confirmations: conf, required });
          }
        }
      }
    }
  }
  // active (unused)
  for (const a of activeAddrs) {
    const utxos = await listUtxo(base, headers, a, fallback);
    if (utxos.length) {
      for (const u of utxos) {
        const conf = await getConfs(base, headers, u.txid);
        items.push({ kind: 'active', address: a, txid: u.txid, vout: u.vout, value: u.value, confirmations: conf, required });
      }
    } else {
      const txs = await listAddressTxs(base, headers, a);
      for (const tx of txs) {
        const txid = String(tx?.txid || tx?.hash || ''); if (!txid) continue;
        const outspends = await getOutspends(base, headers, txid);
        const vouts: any[] = Array.isArray(tx?.vout) ? tx.vout : (Array.isArray(tx?.outputs) ? tx.outputs : []);
        for (let i = 0; i < vouts.length; i++) {
          const out = vouts[i];
          const outAddr = out?.scriptpubkey_address || out?.address || out?.scriptPubKey?.address;
          if (outAddr !== a) continue;
          const spent = Array.isArray(outspends) ? Boolean(outspends[i]?.spent) : true;
          if (!spent) {
            const value = Number(out?.value ?? out?.sats ?? 0);
            const conf = await getConfs(base, headers, txid);
            items.push({ kind: 'active', address: a, txid, vout: i, value, confirmations: conf, required });
          }
        }
      }
    }
  }

  process.stdout.write(JSON.stringify({ items, info: { base, fallback, staticCount: staticAddrs.length, activeCount: activeAddrs.length } }));
}

main().catch((e) => { console.error(JSON.stringify({ items: [], info: { error: String(e?.message || e) } })); process.exit(0); });
