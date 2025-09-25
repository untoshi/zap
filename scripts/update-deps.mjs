#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { cwd } from 'node:process'

const projects = [
  { name: 'mainnet', path: 'apps/mainnet' },
  { name: 'regtest', path: 'apps/regtest' },
]

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    p.stdout.on('data', (b) => (out += b.toString()))
    p.stderr.on('data', (b) => (err += b.toString()))
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code === 0) resolve({ out: out.trim(), err: err.trim() })
      else reject(new Error(`${cmd} ${args.join(' ')} (code ${code})\n${err || out}`))
    })
  })
}

function logTitle(title) {
  const line = '-'.repeat(Math.max(20, title.length))
  console.log(`\n${title}\n${line}`)
}

async function ncuCheck(dir, filter) {
  const args = ['npm-check-updates', '--jsonUpgraded', '--target', 'latest']
  if (filter && filter !== 'all') args.push('--filter', filter)
  const { out } = await run('npx', args, { cwd: dir, env: process.env })
  return out ? JSON.parse(out) : {}
}

async function ncuUpdate(dir, filter) {
  const args = ['npm-check-updates', '-u', '--target', 'latest']
  if (filter && filter !== 'all') args.push('--filter', filter)
  await run('npx', args, { cwd: dir, env: process.env })
}

async function npmInstall(dir) {
  await run('npm', ['install', '--legacy-peer-deps'], { cwd: dir, env: process.env })
}

async function main() {
  const mode = process.argv[2] || 'check'
  // Default to focused scopes to avoid surprise major bumps
  const filter = process.argv[3] || '@buildonspark/*,@flashnet/sdk'
  if (!['check', 'update'].includes(mode)) {
    console.log('Usage: update-deps.mjs <check|update> [filter|all]')
    console.log('Examples:')
    console.log('  node scripts/update-deps.mjs check')
    console.log('  node scripts/update-deps.mjs update')
    console.log("  node scripts/update-deps.mjs update all   # update everything to latest")
    process.exit(1)
  }

  const root = cwd()
  console.log(`Workdir: ${root}`)
  console.log(`Mode: ${mode} Filter: ${filter}`)

  if (mode === 'check') {
    for (const proj of projects) {
      logTitle(`Check ${proj.name} (${proj.path})`)
      try {
        const upgraded = await ncuCheck(proj.path, filter)
        if (Object.keys(upgraded).length === 0) {
          console.log('Up to date.')
        } else {
          console.log(JSON.stringify(upgraded, null, 2))
        }
      } catch (e) {
        console.log(`Error: ${e.message}`)
      }
    }
    return
  }

  if (mode === 'update') {
    for (const proj of projects) {
      logTitle(`Update ${proj.name} (${proj.path})`)
      try {
        const before = await ncuCheck(proj.path, filter)
        if (Object.keys(before).length === 0) {
          console.log('Already up to date; skipping.')
          continue
        }
        console.log('Planned upgrades:')
        console.log(JSON.stringify(before, null, 2))
        await ncuUpdate(proj.path, filter)
        await npmInstall(proj.path)
        const after = await ncuCheck(proj.path, filter)
        if (Object.keys(after).length === 0) console.log('Done. Up to date.')
        else console.log('Remaining (manual attention may be needed):\n' + JSON.stringify(after, null, 2))
      } catch (e) {
        console.log(`Error: ${e.message}`)
      }
    }
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1) })

