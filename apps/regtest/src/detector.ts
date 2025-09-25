#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { ApiClient, AuthManager, TypedAmmApi, getNetworkConfig } from '@flashnet/sdk';
import { CONFIG } from './config.js';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(chalk.cyan('Detector — REGTEST readiness'));
  console.log(chalk.gray(`Network=${CONFIG.network} clientEnv=${CONFIG.clientEnv} interval=${CONFIG.detectionIntervalMs}ms need=${CONFIG.detectionConsecutive}`));

  let mnemonic = CONFIG.mnemonic;
  if (!mnemonic) mnemonic = bip39.generateMnemonic(128);
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network: CONFIG.network } });

  const apiCfg = getNetworkConfig(CONFIG.network);
  const apiClient = new ApiClient(apiCfg);
  console.log(chalk.gray(`ammGatewayUrl=${(apiCfg as any).ammGatewayUrl || 'default'} explorerUrl=${(apiCfg as any).explorerUrl || 'default'}`));
  const auth = new AuthManager(apiClient, await wallet.getIdentityPublicKey(), wallet);
  const api = new TypedAmmApi(apiClient);

  let consecutive = 0;
  while (true) {
    try {
      const startAuth = Date.now();
      let authMsg = 'OK';
      try {
        const token = await auth.authenticate();
        apiClient.setAuthToken(token);
      } catch (ae: any) {
        authMsg = ae?.message || String(ae);
        throw new Error(`Authentication failed: ${authMsg}`);
      } finally {
        console.log(`${new Date().toISOString().split('T')[1]?.replace('Z','')} AUTH ${authMsg} ${Date.now()-startAuth}ms`);
      }

      const startPools = Date.now();
      let count = 0; let poolsMsg = 'OK';
      try {
        const resp = await api.listPools({ limit: 5 });
        count = resp?.pools?.length || 0;
        if (count === 0) poolsMsg = 'Empty';
      } catch (pe: any) { poolsMsg = pe?.message || String(pe); }
      const ts = new Date().toISOString().split('T')[1]?.replace('Z','');
      if (count > 0) { consecutive += 1; console.log(`${ts} ${chalk.green('OK')} pools=${count} consecutive=${consecutive}/${CONFIG.detectionConsecutive} ${Date.now()-startPools}ms`); }
      else { consecutive = 0; console.log(`${ts} ${chalk.yellow('WARN')} pools=${count} msg=${poolsMsg} consecutive=0 ${Date.now()-startPools}ms`); }

      if (consecutive >= CONFIG.detectionConsecutive) {
        console.log(chalk.green(`Readiness reached. Trigger go-live.`));
        process.exit(0);
      }
    } catch (e: any) {
      const ts = new Date().toISOString().split('T')[1]?.replace('Z','');
      console.log(`${ts} ${chalk.red('ERR')} ${(e?.message)||String(e)}`);
      try { const resp = await api.listPools({ limit: 5 }); console.log(`${ts} ${chalk.yellow('INFO')} pools(accessibleWithoutAuth)=${resp?.pools?.length || 0}`); } catch {}
    }
    await sleep(CONFIG.detectionIntervalMs);
  }
}

main().catch((err) => { console.error(chalk.red('Detector failed:'), err?.message || err); process.exit(1); });
