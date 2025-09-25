#!/usr/bin/env ts-node
import 'dotenv/config';
import fetch from 'node-fetch';
import { SparkWallet } from '@buildonspark/spark-sdk';
import * as bip39 from 'bip39';
import type { Network } from './config.js';

type Status = {
  network: Network;
  minConfirmations: number;
  addresses: { static?: string | null };
  deposits: Array<{ txid: string; vout?: number; value?: number; confirmations: number; required: number; claimable: boolean }>;
};

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

function apiBase(network: Network | string) {
  const net = String(network).toUpperCase();
  if (net === 'TESTNET') return 'https://mempool.space/testnet/api';
  if (net === 'SIGNET') return 'https://mempool.space/signet/api';
  return 'https://mempool.space/api';
}

async function listUtxo(base: string, addr: string): Promise<Array<{ txid: string; vout: number; value: number }>> {
  try {
    const res = await fetch(`${base}/address/${addr}/utxo`, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const arr = (await res.json()) as any[];
    if (!Array.isArray(arr)) return [];
    return arr.map((u: any) => ({ txid: String(u?.txid || ''), vout: Number(u?.vout ?? -1), value: Number(u?.value ?? 0) }))
             .filter(u => u.txid && u.vout >= 0);
  } catch { return []; }
}

async function getConfirmations(base: string, txid: string): Promise<number> {
  try {
    const statusRes = await fetch(`${base}/tx/${txid}/status`, { headers: { accept: 'application/json' } });
    const tipRes = await fetch(`${base}/blocks/tip/height`, { headers: { accept: 'text/plain' } });
    if (!statusRes.ok || !tipRes.ok) return 0;
    const status = await statusRes.json() as any;
    const tip = Number(await tipRes.text());
    if (!status?.confirmed) return 0;
    const bh = Number(status?.block_height ?? 0);
    if (!Number.isFinite(bh) || !Number.isFinite(tip) || bh <= 0) return 0;
    return Math.max(0, tip - bh + 1);
  } catch { return 0; }
}

async function listAddressTxs(base: string, addr: string): Promise<any[]> {
  try {
    const res = await fetch(`${base}/address/${addr}/txs`, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return [];
  }
}

async function getOutspends(base: string, txid: string): Promise<any[] | null> {
  try {
    const res = await fetch(`${base}/tx/${txid}/outspends`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

async function main() {
  const network = (envStr('DEFAULT_NETWORK', 'MAINNET') || 'MAINNET').toUpperCase() as Network;
  let mnemonic = envStr('MNEMONIC');
  if (!mnemonic) mnemonic = bip39.generateMnemonic(128);
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic!, options: { network } });
  const status: Status = { network, minConfirmations: envNum('CLAIM_MIN_CONFIRMATIONS', 3), addresses: {}, deposits: [] };

  const base = apiBase(network);
  try {
    const staticAddr = await wallet.getStaticDepositAddress();
    status.addresses.static = staticAddr;
  } catch {}
  const addr = status.addresses.static;
  if (addr) {
    let utxos = await listUtxo(base, addr);
    if (!utxos.length) {
      const txs = await listAddressTxs(base, addr);
      for (const tx of txs) {
        const txid = String(tx?.txid || tx?.hash || '');
        if (!txid) continue;
        const outspends = await getOutspends(base, txid);
        const vouts: any[] = Array.isArray(tx?.vout) ? tx.vout : (Array.isArray(tx?.outputs) ? tx.outputs : []);
        for (let i = 0; i < vouts.length; i++) {
          const out = vouts[i];
          const outAddr = out?.scriptpubkey_address || out?.address || out?.scriptPubKey?.address;
          if (outAddr !== addr) continue;
          const spent = Array.isArray(outspends) ? Boolean(outspends[i]?.spent) : true;
          if (!spent) {
            const value = Number(out?.value ?? out?.sats ?? 0);
            utxos.push({ txid, vout: i, value });
          }
        }
      }
    }
    for (const u of utxos) {
      const confs = await getConfirmations(base, u.txid);
      status.deposits.push({ txid: u.txid, vout: u.vout, value: u.value, confirmations: confs, required: status.minConfirmations, claimable: confs >= status.minConfirmations });
    }
  }

  process.stdout.write(JSON.stringify(status, null, 2));
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
