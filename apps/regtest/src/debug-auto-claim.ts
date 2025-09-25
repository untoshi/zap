#!/usr/bin/env ts-node
import 'dotenv/config';
import fetch from 'node-fetch';
import { SparkWallet } from '@buildonspark/spark-sdk';
import type { Network } from './config.js';

type Cand = { kind: 'static'|'active'; addr: string; txid: string; vout: number; value: number; conf: number };

function envStr(name: string, def?: string): string | undefined {
  const v = process.env[name];
  if (v && v.trim() !== '') return v.trim();
  return def;
}
function envNum(name: string, def?: number): number {
  const v = envStr(name);
  if (v == null) return def ?? 3;
  const n = Number(v);
  return Number.isFinite(n) ? n : (def ?? 3);
}

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
    return arr.map((u: any) => ({ txid: String(u?.txid || ''), vout: Number(u?.vout ?? -1), value: Number(u?.value ?? 0) }))
             .filter(u => u.txid && u.vout >= 0);
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
  const minConf = envNum('CLAIM_MIN_CONFIRMATIONS', 3);
  if (!mnemonic) { console.log('ERR: MNEMONIC not set'); process.exit(1); }
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  const w: any = wallet as any;
  const { base, headers } = electrsInfo(w, network);
  const fallback = mempoolBase(network);

  console.log('--- INPUTS ---');
  console.log(`network=${network}`);
  console.log(`minConfirmations=${minConf}`);
  console.log(`electrsBase=${base}`);
  if (fallback && fallback !== base) console.log(`fallbackMempoolBase=${fallback}`);

  console.log('\n--- ADDRESSES ---');
  let staticAddrs: string[] = [];
  try { staticAddrs = await w.queryStaticDepositAddresses(); } catch {}
  console.log(`static[${staticAddrs.length}]`);
  let activeAddrs: string[] = [];
  try { activeAddrs = await w.getUnusedDepositAddresses(); } catch {}
  console.log(`active(unused)[${activeAddrs.length}]`);

  console.log('\n--- SCAN UTXO ---');
  const cands: Cand[] = [];
  // static
  for (const a of staticAddrs) {
    const utxos = await listUtxo(base, headers, a, fallback);
    for (const u of utxos) {
      const conf = await getConfs(base, headers, u.txid);
      cands.push({ kind: 'static', addr: a, txid: u.txid, vout: u.vout, value: u.value, conf });
    }
    if (utxos.length === 0) {
      // Fallback: txs + outspends
      console.log(`(fallback) utxo empty for static addr; checking txs/outspends: ${a.slice(0,24)}…`);
      const txs = await listAddressTxs(base, headers, a);
      for (const tx of txs) {
        const txid = String(tx?.txid || tx?.hash || '');
        if (!txid) continue;
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
            cands.push({ kind: 'static', addr: a, txid, vout: i, value, conf });
          }
        }
      }
    }
  }
  // active (unused)
  for (const a of activeAddrs) {
    const utxos = await listUtxo(base, headers, a, fallback);
    for (const u of utxos) {
      const conf = await getConfs(base, headers, u.txid);
      cands.push({ kind: 'active', addr: a, txid: u.txid, vout: u.vout, value: u.value, conf });
    }
    if (utxos.length === 0) {
      console.log(`(fallback) utxo empty for active addr; checking txs/outspends: ${a.slice(0,24)}…`);
      const txs = await listAddressTxs(base, headers, a);
      for (const tx of txs) {
        const txid = String(tx?.txid || tx?.hash || '');
        if (!txid) continue;
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
            cands.push({ kind: 'active', addr: a, txid, vout: i, value, conf });
          }
        }
      }
    }
  }
  if (!cands.length) { console.log('No UTXOs found for static/active addresses.'); process.exit(1); }

  // Print candidates summary
  for (const c of cands) {
    const m = c.conf >= minConf ? 'mature' : 'pending';
    console.log(`${c.kind} ${c.addr.slice(0,20)}… tx=${c.txid.slice(0,16)}… vout=${c.vout} value=${c.value} conf=${c.conf} (${m})`);
  }

  const matured = cands.filter(c => c.conf >= minConf);
  if (!matured.length) { console.log('\nNo matured UTXOs yet.'); process.exit(1); }

  // Prefer active first; claim all matured candidates in order by kind, then conf desc
  matured.sort((a,b) => (a.kind === b.kind) ? (b.conf - a.conf) : (a.kind === 'active' ? -1 : 1));

  console.log('\n--- CLAIM RUN ---');
  for (const c of matured) {
    try {
      if (c.kind === 'active') {
        console.log(`ACTIVE claim tx=${c.txid.slice(0,16)}… vout=${c.vout} conf=${c.conf}`);
        const nodes = await wallet.claimDeposit(c.txid);
        console.log('SUCCESS: claimDeposit nodes:');
        console.log(JSON.stringify(nodes, null, 2));
      } else {
        console.log(`STATIC quote+claim tx=${c.txid.slice(0,16)}… vout=${c.vout} conf=${c.conf}`);
        const quote = await w.getClaimStaticDepositQuote(c.txid, c.vout);
        console.log('quote:', JSON.stringify(quote, null, 2));
        const res = await w.claimStaticDeposit({
          transactionId: c.txid,
          creditAmountSats: Number(quote.creditAmountSats),
          sspSignature: quote.signature,
          outputIndex: quote.outputIndex,
        });
        console.log('SUCCESS: static claim:');
        console.log(JSON.stringify(res, null, 2));
      }
    } catch (e: any) {
      console.log('ERROR:', String(e?.message || e));
      if (e?.context) console.log(`context=${JSON.stringify(e.context)}`);
    }
  }
  console.log('--- DONE ---');
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
