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
  const network = (envStr('DEFAULT_NETWORK', 'REGTEST') || 'REGTEST').toUpperCase() as Network;
  const txid = envStr('BITCOIN_TXID');
  const mnemonic = envStr('MNEMONIC');
  if (!txid) { console.log('ERR: BITCOIN_TXID not set'); process.exit(1); }
  if (!mnemonic) { console.log('ERR: MNEMONIC not set'); process.exit(1); }

  console.log('--- INPUTS ---');
  console.log(`network=${network}`);
  console.log(`txid=${txid}`);
  console.log('--------------');

  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  const w: any = wallet as any;

  console.log('\n--- STATIC DEPOSIT CONTEXT ---');
  try {
    const staticAddrs: string[] = await w.queryStaticDepositAddresses();
    console.log(`staticDepositAddresses[${staticAddrs.length}]`);
    console.log(staticAddrs.slice(0, 10).join('\n'));
    if (staticAddrs.length > 10) console.log('...');
  } catch (e) {
    console.log(`Could not fetch static deposit addresses: ${String((e as any)?.message || e)}`);
  }

  console.log('\n--- QUOTE ---');
  try {
    const quote = await w.getClaimStaticDepositQuote(txid);
    console.log(JSON.stringify(quote, null, 2));
    console.log('\n--- CLAIM (STATIC) ---');
    const res = await w.claimStaticDeposit({
      transactionId: txid,
      creditAmountSats: Number(quote.creditAmountSats),
      sspSignature: quote.signature,
      outputIndex: quote.outputIndex,
    });
    console.log('SUCCESS:');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e: any) {
    console.log('ERROR: static-claim failed');
    console.log(`name=${e?.name || 'Error'}`);
    console.log(`message=${e?.message || e}`);
    if (e?.context) console.log(`context=${JSON.stringify(e.context)}`);
    if (e?.stack) console.log(`stack=\n${e.stack}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
