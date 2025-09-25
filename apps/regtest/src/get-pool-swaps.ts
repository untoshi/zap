#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import { IssuerSparkWallet } from '@buildonspark/issuer-sdk';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { FlashnetClient } from '@flashnet/sdk';
import { CONFIG } from './config.js';

async function main() {
  console.log(chalk.cyan('REGTEST — Get Pool Swaps'));

  const poolId = process.env.POOL_ID || '';
  const lookupId = process.env.LOOKUP_ID || '';
  const walletType = (process.env.WALLET_TYPE || 'SPARK').toUpperCase();
  if (!poolId) { console.error(chalk.red('Set POOL_ID in .env to a pool lpPublicKey.')); process.exit(1); }

  // ephemeral mnemonic is fine for auth
  let mnemonic = CONFIG.mnemonic; if (!mnemonic) mnemonic = bip39.generateMnemonic(128);

  let wallet: any;
  if (walletType === 'ISSUER') {
    ({ wallet } = await IssuerSparkWallet.initialize({ mnemonicOrSeed: mnemonic!, options: { network: CONFIG.network } }));
  } else {
    ({ wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic!, options: { network: CONFIG.network } }));
  }

  const client = new FlashnetClient(wallet); await client.initialize();
  console.log(chalk.gray(`Fetching last swaps for pool ${poolId.substring(0, 12)}...`));
  const swaps = await (client as any).getPoolSwaps(poolId, { limit: 50 });
  const items = swaps?.events || swaps?.swaps || swaps;
  if (!items || items.length === 0) { console.log(chalk.yellow('No swaps returned.')); return; }
  for (const s of items) {
    console.log(`- id: ${s.id}\n   in: ${s.amountIn} (${s.assetInAddress?.substring?.(0, 10)})\n   out: ${s.amountOut} (${s.assetOutAddress?.substring?.(0, 10)})\n   price: ${s.price ?? s.executionPrice ?? 'n/a'} | fee: ${s.feePaid ?? 'n/a'}\n   time: ${s.createdAt}`);
  }
  if (lookupId) {
    const hit = items.find((s: any) => String(s.id).startsWith(lookupId) || String(s.id) === lookupId);
    if (hit) { console.log(chalk.green('Lookup match:')); console.log(JSON.stringify(hit, null, 2)); }
    else { console.log(chalk.yellow('Lookup id not found in recent swaps.')); }
  }
}

main().catch((err) => { console.error(chalk.red('Get pool swaps failed:'), err?.message || err); process.exit(1); });
