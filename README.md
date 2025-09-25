# Zap

Zap is a self-contained toolkit for running FlashNet swaps from your laptop. It wraps all the helper scripts you need (wallet setup, deposit watchers, swap execution, regtest tools) behind a friendly text UI so a teammate can get started without touching raw TypeScript.

## What you get
- **Interactive CLI (`npm run cli`)** that guides you through installing dependencies, selecting the network, managing wallets, watching deposits, and running swaps.
- **Two isolated app folders**:
  - `apps/mainnet` — production-ready scripts using the latest `@buildonspark/spark-sdk` and `@flashnet/sdk`.
  - `apps/regtest` — mirrors mainnet flows with extra helpers for local testing.
- **Safe local storage** for wallets per network (`wallets.mainnet.json`, `wallets.regtest.json`, ...). These files stay on your machine and are git-ignored.
- **Utility scripts** for dependency updates (`npm run deps:check`) and a richer terminal experience (`scripts/tui.mjs`).

Nothing in this repo ships with seed phrases, API keys, or personal data. You provide those through your own `.env` file when you are ready.

---

## Before you start
1. **Install Node.js 18 or newer**: <https://nodejs.org/en/download>. During installation, keep the default options.
2. **Install Git** if you plan to pull updates: <https://git-scm.com/downloads>.
3. Optional: have a FlashNet coordinator/gateway endpoint ready if you need mainnet access.

> If you are new to the terminal, open the "Terminal" (macOS) or "Command Prompt" (Windows) and run the commands exactly as shown.

---

## One-time setup (about 5 minutes)
1. **Clone or copy the repo** onto your machine. If you received a ZIP, unzip it somewhere easy like `~/zap`.
2. **Open a terminal** in the project folder (the one that contains `package.json`).
3. Run `npm install` to grab the small CLI dependency (`enquirer`).
4. Copy the sample environment file:
   ```bash
   cp .env.example .env
   ```
5. Edit `.env` with any text editor. At minimum set:
   ```env
   DEFAULT_NETWORK=REGTEST
   ```
   Leave the API key blank unless you already have one.

At this point you are ready to use the guided CLI.

---

## Day-to-day workflow (REGTEST)
1. In the project folder run:
   ```bash
   npm run cli
   ```
   The Zap menu appears. Use the arrow keys to navigate and press **Enter** to select.
2. Choose **Setup environment → REGTEST**. The tool installs the regtest app dependencies for you.
3. Go to **Manage wallets → Add**.
   - Select **Generate** if you want an auto-created mnemonic (it will be shown once—write it down).
   - Or pick **Paste mnemonic** to reuse an existing seed phrase securely kept on your machine.
4. Visit **Show wallet addresses** to copy the Spark address and the taproot deposit address.
5. Fund the taproot deposit from your regtest Bitcoin node/wallet. Wait for the required confirmations.
6. Return to Zap and open **Deposits (status & claim)**. Select the deposit once it turns green and claim it (the BTC moves onto Spark).
7. Finally, choose **Snipe now** or **Go live (detector → snipe)** to run swaps. Zap streams live status and timings so you know what happened.

Everything happens from that single CLI. You can always press `Esc` to go back.

---

## Switching to mainnet
1. Update `.env`:
   ```env
   DEFAULT_NETWORK=MAINNET
   FLASHNET_CLIENT_ENV=mainnet
   ```
2. Run `npm run cli`.
3. Choose **Setup environment → MAINNET** to install the production dependencies.
4. Add or import your mainnet wallet mnemonic via **Manage wallets**. Wallet files are stored locally in `wallets.mainnet.json` and never checked in.
5. Use the same menu actions as regtest. When you snipe, Zap will respect the mainnet defaults (slippage, timing, claim fees) baked into `apps/mainnet`.

> Tip: to claim a specific deposit without watching, set `BITCOIN_TXID=<txid>` inside `.env` and run **Deposits (status & claim)**. Zap will try each supported claim routine automatically.

---

## Menu reference
- **Setup environment**: installs npm packages for the selected network and writes `DEFAULT_NETWORK` into `.env`.
- **Manage wallets**: list, add (generate/paste), remove wallets for the active network.
- **Show addresses**: prints Spark + taproot deposit addresses for selected wallets (static and single-use).
- **Balances**: fetches BTC and token balances; if you set `SPARKSCAN_API_KEY`, token symbols/decimals are enriched automatically.
- **Deposits (status & claim)**: monitors confirmations, highlights when a deposit is ready, and lets you claim it.
- **Auto-claim deposits**: keeps watching for matured deposits and claims them as soon as they qualify.
- **Snipe now** / **Go live (detector → snipe)**: run simulation-plus-execution flows with configurable slippage and watchdog timers from `.env`.
- **Regtest helpers** (REGTEST only): list pools, inspect swaps, create test pools, run debug claim flows.
- **Settings**:
  - `SCAN_ACTIVE_DEPOSIT_ADDRESSES` — enable to scan active deposit addresses in addition to static ones.
  - `SKIP_BALANCE_CHECK` — skip the pre-flight balance fetch (saves~1s; default ON).
  - `SNIPE_MAX_MS` — maximum allowed milliseconds for a single snipe (default 90 000).

---

## Keeping things up to date
- Run `npm run deps:check` in the project root to see if `@buildonspark/*` or `@flashnet/sdk` have updates.
- Run `npm run deps:update` to bump to the latest versions (it uses `npm-check-updates` internally).
- For each environment folder you can also run `npm run build --prefix apps/<network>` to compile TypeScript ahead of time if desired.

---

## Safety checklist
- `.env`, `wallets.*.json`, `.claims.*.json`, and token metadata caches stay on your machine thanks to `.gitignore`.
- Zap never commits mnemonic phrases or API keys. Anything sensitive lives in `.env` or the wallet JSON files you control.
- The CLI creates timestamped backups (`wallets.json.bak-*`) if it migrates legacy wallet files.
- Prefer using separate mnemonics for regtest and mainnet. Zap prompts you any time it auto-generates a mnemonic; copy it somewhere safe.

---

## Troubleshooting
| Problem | Fix |
| --- | --- |
| `enquirer` not found | Run `npm install` in the root folder. |
| Network calls are slow | Check your `.env` values (`MEMPOOL_API_BASE`, `SPARKSCAN_API_KEY`) or your local FlashNet coordinator. |
| Claims fail with fee errors | Increase `CLAIM_MAX_FEE` in `.env` (defaults to `2000`). |
| Token symbols show as long addresses | Add a SparkScan API key (`SPARKSCAN_API_KEY=...`) so Zap can fetch metadata automatically. |

If you get stuck, run `npm run cli`, press `?` (Shift + /) to show Enquirer’s built‑in help, or reach out to the team with the exact command you ran and any on-screen error message.

---

## Repository layout
```
apps/
  mainnet/   # production scripts and TypeScript entry points
  regtest/   # regtest equivalents plus debug helpers
scripts/
  tui.mjs       # Zap interactive menu
  update-deps.mjs
tsconfig.json  # references to both app projects
.env.example   # template for local configuration
wallets.*.json # generated per network (ignored by git)
```

Zap is ready to use as soon as you install dependencies. Everything else is automated by the CLI.
