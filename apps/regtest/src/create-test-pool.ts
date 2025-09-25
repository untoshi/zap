#!/usr/bin/env ts-node
import 'dotenv/config';
import { SparkWallet } from '@buildonspark/spark-sdk';
import type { Network } from './config.js';
import { FlashnetClient, BTC_ASSET_PUBKEY } from '@flashnet/sdk';

function envStr(name: string, def?: string): string | undefined { const v = process.env[name]; return v && v.trim() !== '' ? v.trim() : def; }
function envNum(name: string, def?: number): number { const v = envStr(name); if (v == null) return def ?? 0; const n = Number(v); return Number.isFinite(n) ? n : (def ?? 0); }

async function main() {
  const network = (envStr('DEFAULT_NETWORK', 'REGTEST') || 'REGTEST').toUpperCase() as Network;
  const mnemonic = envStr('MNEMONIC');
  if (!mnemonic) { console.log(JSON.stringify({ ok: false, error: 'MNEMONIC not set' })); process.exit(1); }

  const mode = (envStr('POOL_ACTION', '') || '').toLowerCase(); // 'create' | 'add'
  const poolId = envStr('POOL_ID');
  const tokenAddr = envStr('TOKEN_BTKN');
  const btcSats = BigInt(String(envNum('BTC_SATS', 100)));
  const tokenAmount = BigInt(String(envNum('TOKEN_AMOUNT', 1000000)));
  const lpFeeBps = envNum('LP_FEE_BPS', 30);
  const hostFeeBps = envNum('HOST_FEE_BPS', 10);

  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network } });
  const client = new FlashnetClient(wallet, { autoAuthenticate: true } as any);
  await client.initialize();

  try {
    if (mode === 'add' && poolId) {
      const p = await client.getPool(poolId);
      const aIsBtc = p.assetAAddress === BTC_ASSET_PUBKEY;
      const req = {
        poolId,
        assetAAmount: (aIsBtc ? btcSats : tokenAmount).toString(),
        assetBAmount: (aIsBtc ? tokenAmount : btcSats).toString(),
      } as any;
      const res = await (client as any).addLiquidity(req);
      console.log(JSON.stringify({ ok: true, action: 'add', poolId, requested: req, result: res }, null, 2));
      return;
    }
    if ((mode === 'create' || !mode) && tokenAddr) {
      const req = {
        assetATokenPublicKey: tokenAddr,
        assetBTokenPublicKey: BTC_ASSET_PUBKEY,
        lpFeeRateBps: lpFeeBps,
        totalHostFeeRateBps: hostFeeBps,
        initialLiquidity: {
          assetAAmount: tokenAmount.toString(),
          assetBAmount: btcSats.toString(),
        },
      } as any;
      const res = await (client as any).createConstantProductPool(req);
      console.log(JSON.stringify({ ok: true, action: 'create', request: req, result: res }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: false, error: 'Provide either POOL_ACTION=add with POOL_ID, or POOL_ACTION=create with TOKEN_BTKN' }, null, 2));
    process.exit(1);
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    process.exit(1);
  }
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e?.message || e) })); process.exit(1); });
