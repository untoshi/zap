#!/usr/bin/env ts-node
import 'dotenv/config';
import chalk from 'chalk';
import * as bip39 from 'bip39';
import { SparkWallet } from '@buildonspark/spark-sdk';
import { ApiClient, AuthManager, TypedAmmApi, getNetworkConfig } from '@flashnet/sdk';
import { CONFIG } from './config.js';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(chalk.cyan('Detector — MAINNET readiness'));
  const verbose = true; // always verbose by default
  console.log(chalk.gray(`Network=${CONFIG.network} clientEnv=${CONFIG.clientEnv} interval=${CONFIG.detectionIntervalMs}ms need=${CONFIG.detectionConsecutive}`));

  // Ephemeral/init wallet just for auth/liveness if MNEMONIC not set
  let mnemonic = CONFIG.mnemonic;
  if (!mnemonic) {
    mnemonic = bip39.generateMnemonic(128);
  }
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network: CONFIG.network },
  });

  // Build modular client to control auth explicitly
  const apiCfg = getNetworkConfig(CONFIG.network);
  const apiClient = new ApiClient(apiCfg);
  if (verbose) {
    console.log(chalk.gray(`ammGatewayUrl=${(apiCfg as any).ammGatewayUrl || 'default'} explorerUrl=${(apiCfg as any).explorerUrl || 'default'}`));
  }
  const auth = new AuthManager(apiClient, await wallet.getIdentityPublicKey(), wallet);
  const api = new TypedAmmApi(apiClient);

  let consecutive = 0;
  while (true) {
    try {
      // Auth check (get/refresh token)
      const startAuth = Date.now();
      let token = '';
      let authMsg = 'OK';
      try {
        token = await auth.authenticate();
        apiClient.setAuthToken(token);
      } catch (ae: any) {
        authMsg = ae?.message || String(ae);
        throw new Error(`Authentication failed: ${authMsg}`);
      } finally {
        const dur = Date.now() - startAuth;
        console.log(`${new Date().toISOString().split('T')[1]?.replace('Z','')} AUTH ${authMsg} ${dur}ms`);
      }

      // Pools check
      const startPools = Date.now();
      let count = 0;
      let poolsMsg = 'OK';
      try {
        const resp = await api.listPools({ limit: 5 });
        count = resp?.pools?.length || 0;
        if (count === 0) poolsMsg = 'Empty';
      } catch (pe: any) {
        poolsMsg = pe?.message || String(pe);
      } finally {
        const ts = new Date().toISOString().split('T')[1]?.replace('Z','');
        const dur = Date.now() - startPools;
        if (count > 0) {
          consecutive += 1;
          console.log(`${ts} ${chalk.green('OK')} pools=${count} consecutive=${consecutive}/${CONFIG.detectionConsecutive} ${dur}ms`);
        } else {
          consecutive = 0;
          console.log(`${ts} ${chalk.yellow('WARN')} pools=${count} msg=${poolsMsg} consecutive=0 ${dur}ms`);
        }
      }

      if (consecutive >= CONFIG.detectionConsecutive) {
        console.log('\n' + chalk.green(`Readiness reached (${consecutive} consecutive). Trigger go-live.`));
        process.exit(0);
      }
    } catch (e) {
      consecutive = 0;
      const ts = new Date().toISOString().split('T')[1]?.replace('Z','');
      const msg = (e as any)?.message || String(e);
      console.log(`${ts} ${chalk.red('ERR')} ${msg}`);
      // Try pools without auth for visibility
      try {
        const resp = await api.listPools({ limit: 5 });
        const count2 = resp?.pools?.length || 0;
        console.log(`${ts} ${chalk.yellow('INFO')} pools(accessibleWithoutAuth)=${count2}`);
      } catch (pe) {
        console.log(`${ts} ${chalk.yellow('INFO')} pools(accessibleWithoutAuth)=error ${(pe as any)?.message || pe}`);
      }
    }
    await sleep(CONFIG.detectionIntervalMs);
  }
}

main().catch((err) => {
  console.error(chalk.red('Detector failed:'), err?.message || err);
  process.exit(1);
});
