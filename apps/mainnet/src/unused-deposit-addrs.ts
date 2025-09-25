#!/usr/bin/env ts-node
import 'dotenv/config';
import { SparkWallet } from '@buildonspark/spark-sdk';
import type { Network } from './config.js';

function envStr(name: string, def?: string): string | undefined {
  const v = process.env[name];
  if (v && v.trim() !== '') return v.trim();
  return def;
}

async function main() {
  const network = (envStr('DEFAULT_NETWORK', 'MAINNET') || 'MAINNET').toUpperCase() as Network;
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: envStr('MNEMONIC')!, options: { network } });
  const addrs = await (wallet as any).getUnusedDepositAddresses();
  process.stdout.write(JSON.stringify({ network, addrs }, null, 2));
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
