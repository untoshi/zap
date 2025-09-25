#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { FlashnetClient, BTC_ASSET_PUBKEY } from '@flashnet/sdk';
import { bech32, bech32m } from 'bech32';
import { CONFIG } from './config.js';
import pLimit from 'p-limit';

type Args = { target?: string; amount?: bigint; slippage?: number; pair?: string; preResolvedPool?: string; preResolvedAssetOut?: string; dryResolve?: boolean; dryExecute?: boolean; skipBalance?: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  const rest = argv.slice(2).filter(Boolean);
  const tokens = rest.slice();
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--') continue;
    if (!a.startsWith('--')) { out.target = a; tokens.splice(i, 1); break; }
  }
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (!a) continue;
    if (a === '--amount') { out.amount = BigInt(tokens[++i]); continue; }
    if (a === '--slippage') { out.slippage = parseInt(tokens[++i] || '0', 10); continue; }
    if (a === '--pair') { out.pair = tokens[++i]; continue; }
    if (a === '--preResolvedPool') { out.preResolvedPool = tokens[++i]; continue; }
    if (a === '--preResolvedAssetOut') { out.preResolvedAssetOut = tokens[++i]; continue; }
    if (a === '--dry-resolve') { out.dryResolve = true; continue; }
    if (a === '--dry-execute') { out.dryExecute = true; continue; }
    if (a === '--skip-balance-check') { out.skipBalance = true; continue; }
  }
  return out;
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function isPoolId(s: string) { return /^[0-9a-fA-F]{66}$/.test(s) && (s.startsWith('02') || s.startsWith('03')); }
function isBtkn(s: string) { return s.toLowerCase().startsWith('btkn'); }

async function resolveBestBtcPool(
  client: FlashnetClient,
  target: string,
  amount: bigint,
): Promise<{ poolId: string; assetOutAddress: string; curveType?: string } | null> {
  if (isPoolId(target)) {
    const pool = await client.getPool(target);
    // Require that pool pairs BTC with the other asset, otherwise skip
    if (pool.assetAAddress !== BTC_ASSET_PUBKEY && pool.assetBAddress !== BTC_ASSET_PUBKEY) return null;
    const assetOut = pool.assetAAddress === BTC_ASSET_PUBKEY ? pool.assetBAddress : pool.assetAAddress;
    return { poolId: pool.lpPublicKey, assetOutAddress: assetOut, curveType: pool.curveType };
  }
  if (isBtkn(target)) {
    const decodeHex = (): string | null => {
      try { const d = bech32m.decode(target); const bytes = bech32.fromWords(d.words); return Buffer.from(bytes).toString('hex'); } catch {}
      try { const d = bech32.decode(target); const bytes = bech32.fromWords(d.words); return Buffer.from(bytes).toString('hex'); } catch {}
      return null;
    };
    const hex = decodeHex();
    const candidates = [target];
    if (hex) candidates.unshift(hex, hex.toUpperCase());
    // Gather all pools for token across A/B
    let pools: any[] = [];
    try {
      const reqs: Promise<any>[] = [];
      for (const addr of candidates) {
        reqs.push(client.listPools({ limit: 50, assetAAddress: addr }));
        reqs.push(client.listPools({ limit: 50, assetBAddress: addr }));
      }
      const results = await Promise.allSettled(reqs);
      for (const r of results) {
        if (r.status === 'fulfilled') pools = pools.concat(r.value?.pools || []);
      }
    } catch {}
    if (!pools.length) return null;
    // Filter to pools that include BTC as the counter asset so we can buy with BTC
    const btcPools = pools.filter(p => p.assetAAddress === BTC_ASSET_PUBKEY || p.assetBAddress === BTC_ASSET_PUBKEY);
    if (!btcPools.length) return null;
    // Rank by simulated amountOut for the given amount and pick the best
    let best: any = null;
    let bestOut = -1n;
    const limit = pLimit(4);
    await Promise.all(btcPools.map((p) => limit(async () => {
      try {
        const assetOut = p.assetAAddress === BTC_ASSET_PUBKEY ? p.assetBAddress : p.assetAAddress;
        const sim = await client.simulateSwap({ poolId: p.lpPublicKey, assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: assetOut, amountIn: amount.toString() });
        const out = BigInt(sim.amountOut ?? 0);
        if (out > bestOut) { bestOut = out; best = { poolId: p.lpPublicKey, assetOutAddress: assetOut, curveType: p.curveType }; }
      } catch {}
    })));
    return best;
  }
  // If someone passes ticker here, we could add a quick resolver using BTKN lists, but keep MVP minimal on regtest
  return null;
}

async function resolveFallbackFromPool(
  client: FlashnetClient,
  poolId: string,
  amount: bigint,
): Promise<{ poolId: string; assetOutAddress: string; curveType?: string } | null> {
  try {
    const p = await client.getPool(poolId);
    const tokenAddr = p.assetAAddress === BTC_ASSET_PUBKEY ? p.assetBAddress : p.assetAAddress;
    let pools: any[] = [];
    try {
      const [a, b] = await Promise.allSettled([
        client.listPools({ limit: 50, assetAAddress: tokenAddr }),
        client.listPools({ limit: 50, assetBAddress: tokenAddr }),
      ]);
      if (a.status === 'fulfilled') pools = pools.concat(a.value?.pools || []);
      if (b.status === 'fulfilled') pools = pools.concat(b.value?.pools || []);
    } catch {}
    const btcPools = pools.filter(q => q.assetAAddress === BTC_ASSET_PUBKEY || q.assetBAddress === BTC_ASSET_PUBKEY);
    let best: any = null; let bestOut = -1n;
    const limit2 = pLimit(4);
    await Promise.all(btcPools.map((q) => limit2(async () => {
      try {
        const assetOut = q.assetAAddress === BTC_ASSET_PUBKEY ? q.assetBAddress : q.assetAAddress;
        const sim = await client.simulateSwap({ poolId: q.lpPublicKey, assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: assetOut, amountIn: amount.toString() });
        const out = BigInt(sim.amountOut ?? 0);
        if (out > bestOut) { bestOut = out; best = { poolId: q.lpPublicKey, assetOutAddress: assetOut, curveType: q.curveType }; }
      } catch {}
    })));
    return best;
  } catch { return null; }
}

function defaultSlippageBps(curveType?: string): number {
  const ct = String(curveType || '').toUpperCase();
  if (ct.includes('SINGLE')) return CONFIG.slippageSingleBps;
  return CONFIG.slippageCpBps;
}

async function main() {
  console.log(chalk.cyan('Quick Snipe — REGTEST'));
  const { target, amount, slippage, pair, preResolvedPool, preResolvedAssetOut, dryResolve, dryExecute, skipBalance } = parseArgs(process.argv);
  if (!target || !amount) {
    console.log('Usage: npm run snipe:watch -- <btkn|lpPublicKey> --amount <sats> [--slippage <bps>]');
    process.exit(1);
  }

  let mnemonic = CONFIG.mnemonic;
  if (!mnemonic) {
    mnemonic = bip39.generateMnemonic(256);
    console.log(chalk.yellow('Generated BIP39 mnemonic (save it):'));
    console.log(chalk.greenBright(mnemonic));
  }
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network: CONFIG.network } });
  const client = new FlashnetClient(wallet, { autoAuthenticate: true } as any);

  // loop: wait until live + balance OK, then snipe immediately
  const start = Date.now();
  const hardMaxMs = Number(process.env.SNIPE_MAX_MS || 120000);
  while (true) {
    try {
      const t0 = Date.now();
      const tAuth0 = Date.now();
      await client.initialize();
      const authMs = Date.now() - tAuth0;

      let sats: bigint | null = null;
      let balMs = 0;
      const skipBal = skipBalance || ['1','true','yes','y','on'].includes(String(process.env.SKIP_BALANCE_CHECK || '').toLowerCase());
      if (!skipBal) {
        const tBal0 = Date.now();
        const bal = await client.getBalance();
        balMs = Date.now() - tBal0;
        sats = BigInt(bal.balance ?? 0);
      }

      // Dry resolve mode: just output the resolved pool and timings then exit
      if (dryResolve) {
        const tRes0 = Date.now();
        const resolved = await resolveBestBtcPool(client, target, amount);
        const resolveMs = Date.now() - tRes0;
        if (!resolved) { console.log(JSON.stringify({ ok: false, error: 'Not resolved' })); process.exit(1); }
        console.log(JSON.stringify({ ok: true, ...resolved, timings: { authMs, resolveMs } }));
        return;
      }

      // Pre-resolved path
      let resolved: any = null;
      let resolveMs = 0;
      if (preResolvedPool && preResolvedAssetOut) {
        resolved = { poolId: preResolvedPool, assetOutAddress: preResolvedAssetOut, curveType: undefined };
      } else {
        const tRes0 = Date.now();
        resolved = await resolveBestBtcPool(client, target, amount);
        resolveMs = Date.now() - tRes0;
      }
      if (!resolved) {
        console.log(chalk.gray(`Resolving target... not yet available (auth=${authMs}ms balance=${balMs}ms resolve=${resolveMs}ms)`));
        await sleep(2000); continue;
      }
      if (!skipBal && sats! < amount) {
        console.log(chalk.yellow(`Balance ${sats} < amount ${amount}. Waiting for funds... (auth=${authMs}ms balance=${balMs}ms resolve=${resolveMs}ms)`));
        await sleep(2000); continue;
      }

      let poolId = resolved.poolId;
      let assetOut = resolved.assetOutAddress;
      const bps = slippage ?? defaultSlippageBps(resolved.curveType);
      const balLabel = skipBal ? 'NA' : String(sats);
      console.log(chalk.gray(`Target ready. pool=${poolId.slice(0,12)} curve=${resolved.curveType || 'unknown'} balance=${balLabel} (auth=${authMs}ms balance=${balMs}ms resolve=${resolveMs}ms)`));

      // simulate → minOut (with fallback if direct pool has insufficient liquidity)
      const tSim0 = Date.now();
      let sim: any;
      try {
        sim = await client.simulateSwap({ poolId, assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: assetOut, amountIn: amount.toString() });
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (isPoolId(target) && /FSAG-4201|Insufficient liquidity/i.test(msg)) {
          const fb = await resolveFallbackFromPool(client, poolId, amount);
          if (fb) {
            console.log(chalk.gray(`Fallback: switching to pool ${fb.poolId.slice(0,12)} for better liquidity`));
            // overwrite current selection
            resolved.poolId = fb.poolId; (resolved as any).assetOutAddress = fb.assetOutAddress; (resolved as any).curveType = fb.curveType;
            poolId = fb.poolId; assetOut = fb.assetOutAddress;
            sim = await client.simulateSwap({ poolId, assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: assetOut, amountIn: amount.toString() });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      const simMs = Date.now() - tSim0;
      const expOut = BigInt(sim.amountOut ?? 0);
      if (expOut <= 0n) {
        // Try fallback even if simulate returned zero
        if (isPoolId(target)) {
          const fb = await resolveFallbackFromPool(client, poolId, amount);
          if (fb) {
            console.log(chalk.gray(`Fallback: switching to pool ${fb.poolId.slice(0,12)} due to zero out`));
            resolved.poolId = fb.poolId; (resolved as any).assetOutAddress = fb.assetOutAddress; (resolved as any).curveType = fb.curveType;
            poolId = fb.poolId; assetOut = fb.assetOutAddress;
            // re-simulate once with new pool
            const sim2 = await client.simulateSwap({ poolId, assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: assetOut, amountIn: amount.toString() });
            const out2 = BigInt(sim2.amountOut ?? 0);
            if (out2 > 0n) { sim = sim2; }
            else { console.log(chalk.yellow(`Simulation still zero — retrying... (simulate=${simMs}ms)`)); await sleep(1500); continue; }
          } else {
            console.log(chalk.yellow(`Simulation returned zero — retrying... (simulate=${simMs}ms)`)); await sleep(1500); continue;
          }
        } else {
          console.log(chalk.yellow(`Simulation returned zero — retrying... (simulate=${simMs}ms)`)); await sleep(1500); continue;
        }
      }
      const minOut = (expOut * BigInt(10_000 - bps)) / 10_000n;
      console.log(chalk.gray(`Sim amountOut=${expOut} | minOut@${bps}bps=${minOut} (simulate=${simMs}ms)`));

      // Dry execute: print what we would send and exit
      const doDry = dryExecute || ['1','true','yes','y','on'].includes(String(process.env.DRY_EXECUTE || '').toLowerCase());
      if (doDry) {
        const payload = {
          dryExecute: true,
          poolId,
          assetInAddress: BTC_ASSET_PUBKEY,
          assetOutAddress: assetOut,
          amountIn: amount.toString(),
          minAmountOut: minOut.toString(),
          maxSlippageBps: bps,
          curveType: resolved.curveType || null,
          timings: { authMs, balanceMs: balMs, resolveMs, simulateMs: simMs },
        };
        process.stdout.write(JSON.stringify(payload, null, 2));
        return;
      }

      // execute
      const tExe0 = Date.now();
      const res = await client.executeSwap({ poolId, assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: assetOut, amountIn: amount.toString(), minAmountOut: minOut.toString(), maxSlippageBps: bps });
      const exeMs = Date.now() - tExe0;
      const totalMs = Date.now() - t0;
      console.log(chalk.green(`Swap submitted. requestId=${res.requestId} accepted=${res.accepted} (execute=${exeMs}ms total=${totalMs}ms)`));
      return;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (Date.now() - start > hardMaxMs) { console.log(chalk.red(`Timeout after ${Math.round((Date.now()-start)/1000)}s: ${msg}`)); process.exit(1); }
      console.log(chalk.yellow(`Waiting... ${msg}`));
      await sleep(2000);
    }
  }
}

main().catch((err) => { console.error(chalk.red('Quick snipe failed:'), err?.message || err); process.exit(1); });
