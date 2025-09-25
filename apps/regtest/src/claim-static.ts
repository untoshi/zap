#!/usr/bin/env ts-node
import 'dotenv/config';
import { SparkWallet } from '@buildonspark/spark-sdk';
import type { Network } from './config.js';

function envStr(name: string, def?: string): string | undefined { const v = process.env[name]; return v && v.trim() !== '' ? v.trim() : def; }

async function main() {
  const network = (envStr('DEFAULT_NETWORK', 'REGTEST') || 'REGTEST').toUpperCase() as Network;
  const txid = envStr('BITCOIN_TXID');
  const voutEnv = envStr('BITCOIN_VOUT');
  const vout = voutEnv != null && voutEnv !== '' ? Number(voutEnv) : undefined;
  const mnemonic = envStr('MNEMONIC');
  if (!txid) { console.log(JSON.stringify({ success: false, error: 'BITCOIN_TXID not set' })); process.exit(1); }
  if (!mnemonic) { console.log(JSON.stringify({ success: false, error: 'MNEMONIC not set' })); process.exit(1); }

  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  const w: any = wallet as any;
  try {
    const quote = await w.getClaimStaticDepositQuote(txid, vout);
    const res = await w.claimStaticDeposit({
      transactionId: txid,
      creditAmountSats: Number(quote.creditAmountSats),
      sspSignature: quote.signature,
      outputIndex: quote.outputIndex,
    });
    console.log(JSON.stringify({ success: true, quote, result: res }, null, 2));
  } catch (e: any) {
    console.log(JSON.stringify({ success: false, error: String(e?.message || e) }, null, 2));
    process.exit(1);
  }
}

main().catch((e) => { console.error(JSON.stringify({ success: false, error: String(e?.message || e) })); process.exit(1); });
