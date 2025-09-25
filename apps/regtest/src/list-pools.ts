#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import { IssuerSparkWallet } from '@buildonspark/issuer-sdk';
import { FlashnetClient, BTC_ASSET_PUBKEY } from '@flashnet/sdk';
import { CONFIG } from './config.js';

async function main() {
  console.log(chalk.cyan('REGTEST — List Pools'));
  let mnemonic = CONFIG.mnemonic; if (!mnemonic) { mnemonic = bip39.generateMnemonic(128); console.log(chalk.gray('Generated temp mnemonic (no funds used):')); console.log(chalk.gray(mnemonic)); }
  const { wallet } = await IssuerSparkWallet.initialize({ mnemonicOrSeed: mnemonic!, options: { network: CONFIG.network } });
  const client = new FlashnetClient(wallet); await client.initialize();
  const resp = await client.listPools({ limit: 50 });
  const pools = resp.pools || [];
  console.log(chalk.gray(`Found ${pools.length} pool(s):`));
  const cps = pools.filter((p) => (p.curveType || '').toUpperCase().includes('CONSTANT'));
  if (cps.length > 0) {
    console.log(chalk.green('Suggested CONSTANT_PRODUCT pools:'));
    for (const p of cps.slice(0,10)) {
      const isBtcA = p.assetAAddress === BTC_ASSET_PUBKEY;
      console.log(`- lpPublicKey: ${p.lpPublicKey}\n   assets: ${p.assetAAddress} ${isBtcA ? '(BTC)' : ''} <> ${p.assetBAddress} ${!isBtcA ? '(BTC?)' : ''}\n   curve: ${p.curveType ?? 'unknown'} | host: ${p.hostName ?? 'n/a'} | created: ${p.createdAt}`);
    }
  }
}

main().catch((err) => { console.error(chalk.red('List pools failed:'), err?.message || err); process.exit(1); });
