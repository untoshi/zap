import 'dotenv/config';

export type Network = 'MAINNET' | 'REGTEST' | 'TESTNET' | 'SIGNET' | 'LOCAL';

export function envStr(name: string, def?: string): string | undefined {
  const v = process.env[name];
  if (v && v.trim() !== '') return v.trim();
  return def;
}

export function envNum(name: string, def?: number): number | undefined {
  const v = envStr(name);
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function envBool(name: string, def = false): boolean {
  const v = envStr(name);
  if (!v) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v.toLowerCase());
}

export const CONFIG = {
  network: (envStr('DEFAULT_NETWORK', 'MAINNET') as Network) || 'MAINNET',
  clientEnv: envStr('FLASHNET_CLIENT_ENV', 'mainnet')!,

  detectionIntervalMs: envNum('DETECTION_INTERVAL_MS', 2000)!,
  detectionConsecutive: envNum('DETECTION_CONSECUTIVE_SUCCESSES', 3)!,

  slippageCpBps: envNum('SLIPPAGE_BPS_CP_DEFAULT', 300)!,
  slippageSingleBps: envNum('SLIPPAGE_BPS_SINGLE_SIDED_DEFAULT', 700)!,

  mnemonic: envStr('MNEMONIC'),
  depositMode: envStr('DEPOSIT_MODE', 'static')!,
  claimMaxFee: envNum('CLAIM_MAX_FEE', 2000)!,
  claimMinConfirmations: envNum('CLAIM_MIN_CONFIRMATIONS', 3)!,
};
