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

async function fetchJson(url: string, headers: Record<string,string> = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, json, text };
}

async function fetchText(url: string, headers: Record<string,string> = {}) {
  const res = await fetch(url, { headers: { accept: 'text/plain', ...headers } });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function main() {
  const network = (envStr('DEFAULT_NETWORK', 'REGTEST') || 'REGTEST').toUpperCase() as Network;
  const txid = envStr('BITCOIN_TXID');
  const mnemonic = envStr('MNEMONIC');
  if (!txid) { console.log('ERR: BITCOIN_TXID not set'); process.exit(1); }
  if (!mnemonic) { console.log('ERR: MNEMONIC not set'); process.exit(1); }

  console.log('--- INPUTS ---');
  console.log(`network=${network}`);
  console.log(`txid=${txid}`);
  if (process.env.MEMPOOL_API_BASE) console.log(`MEMPOOL_API_BASE=${process.env.MEMPOOL_API_BASE}`);
  console.log('--------------');

  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  const w: any = wallet as any;
  const cfg = (w as any).config;
  let electrs = '';
  try { electrs = cfg.getElectrsUrl(); } catch {}
  const idPub = await wallet.getIdentityPublicKey();
  const sparkAddr = await wallet.getSparkAddress();
  const staticAddr = await wallet.getStaticDepositAddress();
  let unused: string[] = [];
  try { unused = await (w.getUnusedDepositAddresses?.bind(w)?.() || Promise.resolve([])); } catch {}

  console.log('\n--- WALLET ---');
  console.log(`identityPubKey=${idPub}`);
  console.log(`sparkAddress=${sparkAddr}`);
  console.log(`staticDeposit=${staticAddr}`);
  console.log(`unusedDepositAddresses[${unused.length}]=${unused.slice(0,5).join(', ')}${unused.length>5?' ...':''}`);
  console.log('--------------');

  const memBase = envStr('MEMPOOL_API_BASE');
  if (memBase) {
    console.log('\n--- MEMPOOL CHECK ---');
    const txUrl = `${memBase.replace(/\/$/,'')}/tx/${txid}`;
    const outspendsUrl = `${memBase.replace(/\/$/,'')}/tx/${txid}/outspends`;
    const txRes = await fetchJson(txUrl);
    console.log(`GET ${txUrl} -> ${txRes.status}`);
    console.log(typeof txRes.json === 'string' ? txRes.text.slice(0,400) : JSON.stringify(txRes.json, null, 2));
    const outsRes = await fetchJson(outspendsUrl);
    console.log(`GET ${outspendsUrl} -> ${outsRes.status}`);
    console.log(typeof outsRes.json === 'string' ? outsRes.text.slice(0,400) : JSON.stringify(outsRes.json, null, 2));
    console.log('----------------------');
  }

  if (electrs) {
    console.log('\n--- ELECTRS CHECK ---');
    const base = electrs.replace(/\/$/,'');
    const headers: Record<string,string> = {};
    console.log(`electrsUrl=${base}`);
    try {
      const creds = (cfg?.lrc20ApiConfig?.electrsCredentials) as any;
      if (network === 'REGTEST' && creds?.username && creds?.password) {
        const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
        console.log(`electrs auth user=${creds.username}`);
      }
    } catch {}
    const hexRes = await fetchText(`${base}/tx/${txid}/hex`, headers);
    console.log(`GET ${base}/tx/${txid}/hex -> ${hexRes.status} length=${hexRes.text?.length ?? 0}`);
    const fullHex = hexRes.text || '';
    const showFull = envStr('DEBUG_FULL_HEX') === '1';
    if (showFull) console.log(fullHex);
    else console.log(`${fullHex.slice(0,120)}${fullHex.length>120?'...':''}`);
    console.log('----------------------');
  }

  console.log('\n--- CLAIM ---');
  try {
    const nodes = await wallet.claimDeposit(txid);
    console.log('SUCCESS: claimDeposit returned nodes:');
    console.log(JSON.stringify(nodes, null, 2));
    console.log('------------');
    process.exit(0);
  } catch (e: any) {
    console.log('ERROR: claimDeposit failed');
    console.log(`name=${e?.name || 'Error'}`);
    console.log(`message=${e?.message || e}`);
    if (e?.context) console.log(`context=${JSON.stringify(e.context)}`);
    if (e?.stack) console.log(`stack=\n${e.stack}`);
    console.log('------------');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
