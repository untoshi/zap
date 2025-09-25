#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import enquirer from 'enquirer';
const { Select, MultiSelect, Input, Confirm } = enquirer;

const root = process.cwd();
const appsDir = path.join(root, 'apps');
function walletsFileFor(net) {
  const n = String(net || '').toUpperCase();
  if (n === 'MAINNET') return path.join(root, 'wallets.mainnet.json');
  if (n === 'REGTEST') return path.join(root, 'wallets.regtest.json');
  if (n === 'TESTNET') return path.join(root, 'wallets.testnet.json');
  if (n === 'SIGNET') return path.join(root, 'wallets.signet.json');
  return path.join(root, 'wallets.json');
}

function migrateLegacyWalletsIfNeeded() {
  const legacy = path.join(root, 'wallets.json');
  const anyScopedExists = ['MAINNET','REGTEST','TESTNET','SIGNET'].some((n) => existsSync(walletsFileFor(n)));
  if (!existsSync(legacy) || anyScopedExists) return;
  try {
    const txt = readFileSync(legacy, 'utf-8');
    const data = (txt && JSON.parse(txt)) || {};
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(root, `wallets.json.bak-${ts}`);
    writeFileSync(backup, JSON.stringify(data, null, 2) + '\n');
    writeFileSync(walletsFileFor('MAINNET'), JSON.stringify(data, null, 2) + '\n');
    writeFileSync(walletsFileFor('REGTEST'), JSON.stringify(data, null, 2) + '\n');
  } catch {}
}

function parseRootEnv() {
  const envPath = path.join(root, '.env');
  const out = {};
  if (!existsSync(envPath)) return out;
  const txt = readFileSync(envPath, 'utf-8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}
function saveRootEnv(kv) {
  const envPath = path.join(root, '.env');
  const existing = parseRootEnv();
  const merged = { ...existing, ...kv };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join('\n'));
}
function resolveEnvFromRoot() {
  const env = parseRootEnv();
  const v = String(env.DEFAULT_NETWORK || '').toUpperCase();
  return ['MAINNET', 'REGTEST'].includes(v) ? v : 'MAINNET';
}
function appPathFor(net) { return path.join(appsDir, net === 'REGTEST' ? 'regtest' : 'mainnet'); }

function run(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
    p.on('error', reject);
  });
}
function runSilent(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    let out = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited with code ${code}: ${out}`)));
    p.on('error', reject);
  });
}
function withApp(net, script, passArgs=[]) {
  const appPath = appPathFor(net);
  const args = ['run', script, '--prefix', appPath];
  if (passArgs.length) args.push('--', ...passArgs);
  return run('npm', args);
}
function withAppSilent(net, script, passArgs=[], envOverride={}) {
  const appPath = appPathFor(net);
  const args = ['run', script, '--prefix', appPath];
  if (passArgs.length) args.push('--', ...passArgs);
  const rootEnv = parseRootEnv();
  const env = {
    ...process.env,
    ...envOverride,
    SPARKSCAN_API_KEY: envOverride.SPARKSCAN_API_KEY || process.env.SPARKSCAN_API_KEY || rootEnv.SPARKSCAN_API_KEY,
    MEMPOOL_API_BASE: envOverride.MEMPOOL_API_BASE || process.env.MEMPOOL_API_BASE || rootEnv.MEMPOOL_API_BASE,
    SKIP_BALANCE_CHECK: envOverride.SKIP_BALANCE_CHECK || process.env.SKIP_BALANCE_CHECK || rootEnv.SKIP_BALANCE_CHECK || '1',
    SCAN_ACTIVE_DEPOSIT_ADDRESSES: envOverride.SCAN_ACTIVE_DEPOSIT_ADDRESSES || process.env.SCAN_ACTIVE_DEPOSIT_ADDRESSES || rootEnv.SCAN_ACTIVE_DEPOSIT_ADDRESSES,
    SNIPE_MAX_MS: envOverride.SNIPE_MAX_MS || process.env.SNIPE_MAX_MS || rootEnv.SNIPE_MAX_MS || '90000',
    npm_config_loglevel: 'silent',
  };
  return runSilent('npm', args, { env });
}

function clearScreen() {
  try { process.stdout.write('\x1Bc'); } catch {}
}

// Simple CLI spinner
const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerTimer = null;
let spinnerIdx = 0;
function hideCursor() { try { process.stdout.write('\u001B[?25l'); } catch {} }
function showCursor() { try { process.stdout.write('\u001B[?25h'); } catch {} }
function startSpinner(text = 'Loading…') {
  if (spinnerTimer) return;
  spinnerIdx = 0; hideCursor();
  spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % frames.length;
    process.stdout.write(`\r${frames[spinnerIdx]} ${text}`);
  }, 80);
}
function stopSpinner() {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer); spinnerTimer = null;
  process.stdout.write('\r'); showCursor();
}

async function showOutput(title, content) {
  clearScreen();
  const sep = '-'.repeat(30);
  console.log(`${title}\n${sep}\n${content}\n${sep}`);
  await new Input({ name: 'back', message: 'Press Enter to return to menu' }).run();
  clearScreen();
}

function parseJsonStable(out) {
  try { return JSON.parse(out); } catch {}
  const i = out.indexOf('{');
  const j = out.lastIndexOf('}');
  if (i >= 0 && j > i) {
    const s = out.slice(i, j + 1);
    try { return JSON.parse(s); } catch {}
  }
  throw new Error('Invalid JSON output');
}

function loadWalletsFor(net) {
  migrateLegacyWalletsIfNeeded();
  const f = walletsFileFor(net);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf-8') || '{}') || {}; } catch { return {}; }
}
function saveWalletsFor(net, map) {
  migrateLegacyWalletsIfNeeded();
  const f = walletsFileFor(net);
  writeFileSync(f, JSON.stringify(map, null, 2) + '\n');
}

async function setupNetwork() {
  const choice = await new Select({ name: 'setup', message: 'Setup which environment?', choices: ['MAINNET', 'REGTEST', 'Cancel'] }).run();
  if (choice === 'Cancel') return;
  const NET = choice;
  const appPath = appPathFor(NET);
  const envFile = path.join(appPath, '.env');
  const envExample = path.join(appPath, '.env.example');
  if (!existsSync(envFile) && existsSync(envExample)) {
    copyFileSync(envExample, envFile);
    console.log(`Created ${path.relative(root, envFile)} from .env.example`);
  }
  saveRootEnv({ DEFAULT_NETWORK: NET });
  console.log(`Set DEFAULT_NETWORK=${NET} in .env`);
  await run('npm', ['install', '--legacy-peer-deps', '--prefix', appPath]);
}

async function pickNetwork() {
  const current = resolveEnvFromRoot();
  const choice = await new Select({ name: 'net', message: `Select network (default: ${current})`, choices: ['MAINNET', 'REGTEST', 'Use default'] }).run();
  return choice === 'Use default' ? current : choice;
}

async function pickWallets(NET, title='Select wallet(s)') {
  const store = loadWalletsFor(NET);
  const names = Object.keys(store);
  if (!names.length) { console.log('No wallets saved. Use Manage wallets → Add first.'); return []; }
  if (names.length === 1) return [names[0]];
  const choices = names.map(n => ({ name: n, value: n, message: n }));
  const selected = await new MultiSelect({ name: 'wallets', message: title, choices, hint: '(Space to select, Enter to confirm)' }).run();
  return selected;
}

async function showAddresses(NET) {
  const selected = await pickWallets(NET, 'Show addresses for:');
  if (!selected.length) return;
  const store = loadWalletsFor(NET);
  const rootEnv = parseRootEnv();
  const includeActive = ['1','true','yes','y','on'].includes(String(rootEnv.SCAN_ACTIVE_DEPOSIT_ADDRESSES || '0').toLowerCase());
  startSpinner('Fetching addresses…');
  let out = '';
  for (const name of selected) {
    out += `\n=== Wallet: ${name} (${NET}) ===\n`;
    try {
      let txt = await withAppSilent(NET, 'wallet:address', [], { MNEMONIC: store[name].mnemonic, DEFAULT_NETWORK: NET });
      // Hide single-use address lines to avoid confusion for now
      txt = txt.split(/\r?\n/).filter(l => !/Single-use Taproot deposit:/i.test(l)).join('\n');
      // Append active/unused deposit address if available
      if (includeActive) {
        try {
          const u = await withAppSilent(NET, 'wallet:unused-addrs', [], { MNEMONIC: store[name].mnemonic, DEFAULT_NETWORK: NET });
          const addrs = (parseJsonStable(u).addrs || []).filter(Boolean);
          if (Array.isArray(addrs) && addrs.length) {
            const active = String(addrs[0]);
            txt += `\nActive deposit address: ${active}`;
          }
        } catch {}
      }
      out += txt + '\n';
    }
    catch (e) { out += String(e?.message || e) + '\n'; }
  }
  stopSpinner();
  await showOutput('Addresses', out.trim());
}

async function showBalances(NET) {
  const selected = await pickWallets(NET, 'Check balances for:');
  if (!selected.length) return;
  const store = loadWalletsFor(NET);
  startSpinner('Fetching balances…');
  let out = '';
  for (const name of selected) {
    out += `\n=== Wallet: ${name} (${NET}) ===\n`;
    try { out += (await withAppSilent(NET, 'wallet:balance', [], { MNEMONIC: store[name].mnemonic, DEFAULT_NETWORK: NET })) + '\n'; }
    catch (e) { out += String(e?.message || e) + '\n'; }
  }
  stopSpinner();
  await showOutput('Balances', out.trim());
}

async function claimDeposit(NET) {
  const selected = await pickWallets(NET, 'Claim for wallet(s):');
  if (!selected.length) return;
  const txid = await new Input({ name: 'txid', message: 'Enter BITCOIN_TXID (static deposit):' }).run();
  if (!txid) return;
  const store = loadWalletsFor(NET);
  startSpinner('Submitting claim…');
  let out = '';
  for (const name of selected) {
    out += `\n=== Wallet: ${name} (${NET}) ===\n`;
    try { out += (await withAppSilent(NET, 'wallet:watch-claim', [], { MNEMONIC: store[name].mnemonic, DEFAULT_NETWORK: NET, BITCOIN_TXID: txid })) + '\n'; }
    catch (e) { out += String(e?.message || e) + '\n'; }
  }
  stopSpinner();
  await showOutput('Claim result', out.trim());
}

async function depositsUI(NET) {
  console.log('This view has been replaced by Claim deposits (auto).');
}

async function claimDepositsAutoUI(NET) {
  const store = loadWalletsFor(NET);
  const names = Object.keys(store);
  if (!names.length) { console.log('No wallets saved.'); return; }
  while (true) {
    startSpinner('Scanning wallets for deposits…');
    const items = [];
    for (const name of names) {
      try {
        const out = await withAppSilent(NET, 'scan:deposits', [], { MNEMONIC: store[name].mnemonic, DEFAULT_NETWORK: NET });
        const j = parseJsonStable(out);
        const arr = Array.isArray(j.items) ? j.items : [];
        for (const it of arr) items.push({ wallet: name, ...it });
      } catch (e) {}
    }
    stopSpinner();

    if (!items.length) {
      await showOutput('Claim deposits', 'No incoming deposits detected across wallets.');
      break;
    }
    // Build selection with matured enabled, pending disabled
    const choices = items.map((it, i) => {
      const mature = it.confirmations >= it.required;
      const label = `${it.wallet} — ${it.kind.toUpperCase()} — ${String(it.value)} sats — ${it.txid.slice(0,12)}… vout=${it.vout} — ${it.confirmations}/${it.required}`;
      return { name: String(i), message: label, value: i, disabled: mature ? false : 'waiting' };
    });

    const picks = await new MultiSelect({ name: 'toClaim', message: 'Select matured deposits to claim (Space to toggle, Enter to confirm)', choices }).run();
    if (!Array.isArray(picks) || picks.length === 0) {
      // Ask to refresh or exit
      const action = await new Select({ name: 'next', message: 'No selection. What next?', choices: ['Refresh', 'Exit'] }).run();
      if (action === 'Exit') break; else continue;
    }

    startSpinner('Claiming selected deposits…');
    let out = '';
    for (const idx of picks) {
      const it = items[Number(idx)];
      try {
        if (it.kind === 'active') {
          const env = { MNEMONIC: store[it.wallet].mnemonic, DEFAULT_NETWORK: NET, BITCOIN_TXID: it.txid };
          const res = await withAppSilent(NET, 'wallet:claim-tx', [], env);
          out += `\n[OK] ${it.wallet} ACTIVE ${it.txid.slice(0,16)}…\n${res}\n`;
        } else {
          const env = { MNEMONIC: store[it.wallet].mnemonic, DEFAULT_NETWORK: NET, BITCOIN_TXID: it.txid, BITCOIN_VOUT: String(it.vout) };
          const res = await withAppSilent(NET, 'wallet:claim-static', [], env);
          out += `\n[OK] ${it.wallet} STATIC ${it.txid.slice(0,16)}…\n${res}\n`;
        }
      } catch (e) {
        out += `\n[ERR] ${it.wallet} — ${it.txid.slice(0,16)}…\n${String(e?.message || e)}\n`;
      }
    }
    stopSpinner();
    await showOutput('Claim results', out.trim());
    break;
  }
}

async function listPools(NET) {
  if (NET !== 'REGTEST') { console.log('Pools are only available on REGTEST.'); return; }
  startSpinner('Loading pools…');
  const content = await withAppSilent(NET, 'list:pools');
  stopSpinner();
  await showOutput('Pools', content);
}
async function recentSwaps(NET) {
  if (NET !== 'REGTEST') { console.log('Swaps are only available on REGTEST.'); return; }
  const poolId = await new Input({ name: 'pool', message: 'Enter POOL_ID (lpPublicKey) for recent swaps:' }).run();
  if (!poolId) return;
  startSpinner('Loading recent swaps…');
  const content = await withAppSilent(NET, 'get:swaps', [], { POOL_ID: poolId, DEFAULT_NETWORK: NET });
  stopSpinner();
  await showOutput('Recent swaps', content);
}

async function regtestCreateOrFundPool(NET) {
  if (NET !== 'REGTEST') { console.log('This helper is only available on REGTEST.'); return; }
  const action = await new Select({ name: 'act', message: 'Create or fund a pool?', choices: ['Create new pool', 'Add liquidity to pool', 'Cancel'] }).run();
  if (action === 'Cancel') return;
  let env = { DEFAULT_NETWORK: NET };
  if (action === 'Create new pool') {
    const token = await new Input({ name: 'token', message: 'TOKEN_BTKN (bech32/hex):' }).run(); if (!token) return;
    const btc = await new Input({ name: 'btc', message: 'Initial BTC (sats) [default 100]:' }).run();
    const tok = await new Input({ name: 'tok', message: 'Initial token amount [default 1000000]:' }).run();
    const lp = await new Input({ name: 'lp', message: 'LP fee bps [default 30]:' }).run();
    const host = await new Input({ name: 'host', message: 'Host fee bps [default 10]:' }).run();
    env = { ...env, TOKEN_BTKN: token, BTC_SATS: String(btc || 100), TOKEN_AMOUNT: String(tok || 1000000), LP_FEE_BPS: String(lp || 30), HOST_FEE_BPS: String(host || 10), POOL_ACTION: 'create' };
  } else {
    const pool = await new Input({ name: 'pool', message: 'POOL_ID (lpPublicKey):' }).run(); if (!pool) return;
    const btc = await new Input({ name: 'btc', message: 'BTC (sats) [default 100]:' }).run();
    const tok = await new Input({ name: 'tok', message: 'Token amount [default 1000000]:' }).run();
    env = { ...env, POOL_ID: pool, BTC_SATS: String(btc || 100), TOKEN_AMOUNT: String(tok || 1000000), POOL_ACTION: 'add' };
  }
  // Wallet prompt
  const selected = await pickWallets(NET, 'Select wallet to use:');
  if (!selected.length) return;
  const store = loadWalletsFor(NET);
  const name = selected[0];
  startSpinner(action === 'Create new pool' ? 'Creating pool…' : 'Adding liquidity…');
  try {
    const out = await withAppSilent(NET, 'create:test-pool', [], { ...env, MNEMONIC: store[name].mnemonic });
    stopSpinner();
    await showOutput('Test pool result', out);
  } catch (e) {
    stopSpinner();
    await showOutput('Test pool error', String(e?.message || e));
  }
}

async function snipeFlow(NET, goLive=false) {
  const wallStart = Date.now();
  const selected = await pickWallets(NET, 'Select wallets to snipe with:');
  if (!selected.length) return;
  const target = await new Input({ name: 'target', message: 'Enter target (<btkn|lpPublicKey>):' }).run();
  const amount = await new Input({ name: 'amount', message: 'Amount (sats):', validate: v => /^\d+$/.test(v) || 'Enter integer sats' }).run();
  const slippage = await new Input({ name: 'slippage', message: 'Slippage bps (optional):' }).run();
  const args = ['--', target, '--amount', String(amount)];
  if (slippage) args.push('--slippage', String(slippage));
  const store = loadWalletsFor(NET);
  const rootEnv = parseRootEnv();
  const dryExec = ['1','true','yes','y','on'].includes(String(rootEnv.DRY_EXECUTE || '0').toLowerCase());

  // Optional readiness check (go live)
  let detectorNote = '';
  let detectorMs = 0;
  if (goLive) {
    startSpinner('Checking readiness…');
    try {
      const d0 = Date.now();
      const detOut = await withAppSilent(NET, 'detector');
      detectorMs = Date.now() - d0;
      if (/Readiness reached\./i.test(detOut)) detectorNote = 'Detector: readiness reached.';
    } catch (e) {
      // Show detector output on failure to help debugging
      stopSpinner();
      await showOutput('Detector error', String(e?.message || e));
      return;
    }
    stopSpinner();
  }

  // Helper: parse snipe logs to summary
  const parseSnipeOutput = (txt) => {
    const lines = String(txt || '').split(/\r?\n/);
    const info = { pool: null, curve: null, balance: null, authMs: null, balMs: null, resolveMs: null, simMs: null, amountOut: null, minOut: null, bps: null, executeMs: null, totalMs: null, requestId: null, accepted: null };
    for (const l of lines) {
      const ready = l.match(/Target ready\. pool=([0-9a-fA-F]{12})[^]*?curve=([^\s]+)[^]*?balance=([0-9A-Za-z]+) \(auth=(\d+)ms balance=(\d+)ms resolve=(\d+)ms\)/);
      if (ready) { info.pool = ready[1]; info.curve = ready[2]; info.balance = ready[3]; info.authMs = +ready[4]; info.balMs = +ready[5]; info.resolveMs = +ready[6]; }
      const sim = l.match(/Sim amountOut=(\d+) \| minOut@(\d+)bps=(\d+) \(simulate=(\d+)ms\)/);
      if (sim) { info.amountOut = sim[1]; info.bps = sim[2]; info.minOut = sim[3]; info.simMs = +sim[4]; }
      const sub = l.match(/Swap submitted\. requestId=([^\s]+) accepted=(true|false) \(execute=(\d+)ms total=(\d+)ms\)/);
      if (sub) { info.requestId = sub[1]; info.accepted = sub[2] === 'true'; info.executeMs = +sub[3]; info.totalMs = +sub[4]; }
    }
    return info;
  };

  // Pre-resolve best pool once
  startSpinner('Resolving best pool…');
  let pre = null;
  const preStart = Date.now();
  try {
    const preOut = await withAppSilent(NET, 'snipe:watch', ['--', target, '--amount', String(amount), ...(slippage ? ['--slippage', String(slippage)] : []), '--dry-resolve']);
    pre = parseJsonStable(preOut);
    if (!pre?.ok) throw new Error('Resolve failed');
  } catch (e) {
    stopSpinner();
    await showOutput('Resolve error', String(e?.message || e));
    return;
  }
  stopSpinner();
  const preMs = Date.now() - preStart;

  startSpinner(`Sniping ${selected.length} wallet(s)…`);
  const proms = selected.map(async (name) => {
    const env = { MNEMONIC: store[name].mnemonic, DEFAULT_NETWORK: NET };
    const t0 = Date.now();
    try {
      const out = await withAppSilent(NET, 'snipe:watch', [...args, ...(dryExec ? ['--dry-execute'] : []), '--preResolvedPool', pre.poolId, '--preResolvedAssetOut', pre.assetOutAddress], env);
      const dur = Date.now() - t0;
      return { name, ok: true, out, dur };
    } catch (e) {
      const dur = Date.now() - t0;
      return { name, ok: false, out: String(e?.message || e), dur };
    }
  });
  const results = await Promise.all(proms);
  stopSpinner();
  const totalWall = Date.now() - wallStart;
  const maxSnipe = results.length ? Math.max(...results.map(r => r.dur)) : 0;
  const overhead = Math.max(0, totalWall - preMs - maxSnipe - detectorMs);
  const fmt = (ms) => `${(ms/1000).toFixed(2)}s`;

  // Build summary output
  let out = '';
  out += `Total elapsed (wall clock): ${fmt(totalWall)}\n`;
  if (goLive && detectorNote) out += `${detectorNote} (${fmt(detectorMs)})\n`;
  out += `Pre-resolve: ${fmt(preMs)}\n`;
  out += `Snipes (max per wallet): ${fmt(maxSnipe)}\n`;
  if (overhead > 0) out += `Overhead (UI/parse/IO): ${fmt(overhead)}\n`;
  for (const r of results) {
    out += `\n=== Wallet: ${r.name} (${NET}) ===\n`;
    if (!r.ok) {
      out += `[ERR] ${r.out}\n`;
      continue;
    }
    const info = (function() {
      // Support dry-execute JSON output as well
      try {
        const j = parseJsonStable(r.out);
        if (j && j.dryExecute) {
          return {
            requestId: null,
            accepted: null,
            pool: (j.poolId || '').slice(0,12),
            curve: j.curveType || 'unknown',
            balance: 'NA',
            authMs: j.timings?.authMs ?? null,
            balMs: j.timings?.balanceMs ?? null,
            resolveMs: j.timings?.resolveMs ?? null,
            simMs: j.timings?.simulateMs ?? null,
            amountOut: null,
            minOut: j.minAmountOut,
            bps: j.maxSlippageBps,
            executeMs: null,
            totalMs: r.dur,
          };
        }
      } catch {}
      return parseSnipeOutput(r.out);
    })();
    if (info.requestId) {
      out += `[OK] requestId=${info.requestId} accepted=${info.accepted} total=${info.totalMs ?? r.dur}ms` + '\n';
      if (info.totalMs != null && info.totalMs !== r.dur) out += `(wall=${r.dur}ms)\n`;
      if (info.pool) out += `Pool=${info.pool} Curve=${info.curve || 'unknown'} Balance=${info.balance}\n`;
      if (info.authMs != null) out += `Timings: auth=${info.authMs}ms balance=${info.balMs}ms resolve=${info.resolveMs}ms simulate=${info.simMs}ms execute=${info.executeMs}ms total=${info.totalMs ?? r.dur}ms\n`;
      if (info.amountOut != null) out += `Simulated: amountOut=${info.amountOut} minOut@${info.bps}bps=${info.minOut}\n`;
    } else {
      // Dry execute summary
      if (dryExec && info.minOut) {
        out += `[DRY] Would execute: minOut=${info.minOut} at slippage=${info.bps}bps (wall=${r.dur}ms)\n`;
        if (info.pool) out += `Pool=${info.pool} Curve=${info.curve || 'unknown'}\n`;
        if (info.authMs != null) out += `Timings: auth=${info.authMs}ms balance=${info.balMs}ms resolve=${info.resolveMs}ms simulate=${info.simMs}ms\n`;
      } else {
        // Fallback: show last lines if no standard markers found
        const last = r.out.split(/\r?\n/).slice(-6).join('\n');
        out += last + '\n';
        out += `(duration=${r.dur}ms)\n`;
      }
    }
  }
  await showOutput(goLive ? 'Go live — Snipe results' : 'Snipe results', out.trim());
}

async function manageWallets(NET) {
  const choice = await new Select({ name: 'wman', message: 'Wallet manager', choices: ['List', 'Add (generate)', 'Add (paste mnemonic)', 'Remove', 'Back'] }).run();
  if (choice === 'Back') return;
  const store = loadWalletsFor(NET);
  if (choice === 'List') {
    const names = Object.keys(store);
    console.log(names.length ? `Saved wallets:\n- ${names.join('\n- ')}` : 'No wallets saved.');
  } else if (choice === 'Add (generate)') {
    const name = await new Input({ name: 'name', message: 'Name for wallet:' }).run();
    if (!name) return;
    // generate mnemonic via app dep
    const appPath = appPathFor('REGTEST');
    const code = "import('bip39').then(m => { const b=m.default||m; process.stdout.write(b.generateMnemonic(256)) })";
    const mnemonic = (await runSilent('node', ['-e', code], { cwd: appPath })).trim();
    store[name] = { mnemonic };
    saveWalletsFor(NET, store);
    console.log(`Saved wallet '${name}'.`);
  } else if (choice === 'Add (paste mnemonic)') {
    const name = await new Input({ name: 'name', message: 'Name for wallet:' }).run();
    if (!name) return;
    const mnemonic = await new Input({ name: 'm', message: 'Paste BIP39 mnemonic:' }).run();
    if (!mnemonic) return;
    store[name] = { mnemonic: mnemonic.trim() };
    saveWalletsFor(NET, store);
    console.log(`Saved wallet '${name}'.`);
  } else if (choice === 'Remove') {
    const names = Object.keys(store);
    if (!names.length) { console.log('No wallets saved.'); return; }
    const name = await new Select({ name: 'name', message: 'Select wallet to remove', choices: names }).run();
    const yes = await new Confirm({ name: 'y', message: `Remove wallet '${name}'?` }).run();
    if (!yes) return;
    delete store[name];
    saveWalletsFor(NET, store);
    console.log(`Removed wallet '${name}'.`);
  }
}

async function manageSettings() {
  const rootEnv = parseRootEnv();
  const activeScan = ['1','true','yes','y','on'].includes(String(rootEnv.SCAN_ACTIVE_DEPOSIT_ADDRESSES || '0').toLowerCase());
  const skipBal = ['1','true','yes','y','on'].includes(String(rootEnv.SKIP_BALANCE_CHECK || '1').toLowerCase());
  const choices = [
    { key: 'toggleActive', label: `${activeScan ? 'Turn OFF' : 'Turn ON'} active deposit scanning` },
    { key: 'toggleSkipBal', label: `${skipBal ? 'Turn OFF' : 'Turn ON'} skip balance check (saves ~1s)` },
    { key: 'toggleDryExec', label: `${['1','true','yes','y','on'].includes(String(rootEnv.DRY_EXECUTE || '0').toLowerCase()) ? 'Turn OFF' : 'Turn ON'} dry execute (no send)` },
    { key: 'back', label: 'Back' },
  ];
  const choice = await new Select({ name: 'settings', message: 'Settings', choices: choices.map(c => c.label) }).run();
  if (choice === choices[2].label) return;
  if (choice === choices[0].label) {
    const next = !activeScan; saveRootEnv({ SCAN_ACTIVE_DEPOSIT_ADDRESSES: next ? '1' : '0' });
    console.log(`Set SCAN_ACTIVE_DEPOSIT_ADDRESSES=${next ? '1' : '0'} in .env`);
  } else if (choice === choices[1].label) {
    const next = !skipBal; saveRootEnv({ SKIP_BALANCE_CHECK: next ? '1' : '0' });
    console.log(`Set SKIP_BALANCE_CHECK=${next ? '1' : '0'} in .env (saves ~1s)`);
  } else if (choice === choices[2].label) {
    const current = ['1','true','yes','y','on'].includes(String(rootEnv.DRY_EXECUTE || '0').toLowerCase());
    const next = !current; saveRootEnv({ DRY_EXECUTE: next ? '1' : '0' });
    console.log(`Set DRY_EXECUTE=${next ? '1' : '0'} in .env (no on-chain send)`);
  }
}

async function main() {
console.log('Clunkers — Interactive TUI');
let NET = await (async () => {
  const current = resolveEnvFromRoot();
  try {
    const choice = await new Select({ name: 'net', message: `Select network (default: ${current})`, choices: ['Use default', 'MAINNET', 'REGTEST'] }).run();
    return choice === 'Use default' ? current : choice;
  } catch {
    return current;
  }
})();
console.log(`Using network: ${NET}`);
  while (true) {
    const action = await new Select({
      name: 'menu',
      message: 'Main menu',
      choices: [
        { name: 'setup', message: 'Setup environment' },
        { name: 'addr', message: 'Show wallet addresses' },
        { name: 'bal', message: 'Check wallet balances' },
        { name: 'claim-auto', message: 'Claim deposits (auto)' },
        { name: 'settings', message: 'Settings' },
        { name: 'snipe', message: 'Snipe now' },
        { name: 'golive', message: 'Go live (detector → snipe)' },
        { name: 'pools', message: 'List pools (REGTEST)' },
        { name: 'swaps', message: 'Recent swaps (REGTEST)' },
        { name: 'testpool', message: 'Create/fund test pool (REGTEST)' },
        { name: 'wallets', message: 'Manage wallets' },
        { name: 'network', message: 'Change network' },
        { name: 'exit', message: 'Exit' },
      ],
    }).run();
    if (action === 'exit') break;
    try {
      if (action === 'setup') await setupNetwork();
      else if (action === 'addr') await showAddresses(NET);
      else if (action === 'bal') await showBalances(NET);
      else if (action === 'claim-auto') await claimDepositsAutoUI(NET);
      else if (action === 'snipe') await snipeFlow(NET, false);
      else if (action === 'golive') await snipeFlow(NET, true);
      else if (action === 'pools') await listPools(NET);
      else if (action === 'swaps') await recentSwaps(NET);
      else if (action === 'settings') await manageSettings();
      else if (action === 'testpool') await regtestCreateOrFundPool(NET);
      else if (action === 'wallets') await manageWallets(NET);
      else if (action === 'network') {
        const current = resolveEnvFromRoot();
        const choice = await new Select({ name: 'net2', message: `Select network (current: ${NET}, default: ${current})`, choices: ['Use default', 'MAINNET', 'REGTEST'] }).run();
        NET = choice === 'Use default' ? current : choice;
        console.log(`Switched to: ${NET}`);
      }
    } catch (e) {
      console.log(String(e?.message || e));
    }
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
