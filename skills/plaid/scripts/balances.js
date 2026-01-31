#!/usr/bin/env node

import { plaidClient } from './lib/plaid-client.js'
import { readTokens } from './lib/tokens.js'

const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')

async function main() {
  const tokens = await readTokens()
  if (tokens.length === 0) {
    console.error('No connected accounts. Run server.js first to connect a bank.')
    process.exit(1)
  }

  const allAccounts = []

  for (const item of tokens) {
    try {
      const res = await plaidClient.accountsGet({ access_token: item.access_token })
      for (const acct of res.data.accounts) {
        allAccounts.push({
          institution: item.institution_name,
          name: acct.name,
          type: acct.subtype || acct.type,
          balance: acct.balances.current,
          available: acct.balances.available,
        })
      }
    } catch (err) {
      console.error(`Error fetching ${item.institution_name}: ${err.response?.data?.error_message || err.message}`)
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allAccounts, null, 2))
    return
  }

  if (allAccounts.length === 0) {
    console.log('No accounts found.')
    return
  }

  // Table output
  const colWidths = {
    institution: Math.max(11, ...allAccounts.map((a) => a.institution.length)),
    name: Math.max(7, ...allAccounts.map((a) => a.name.length)),
    type: Math.max(4, ...allAccounts.map((a) => (a.type || '').length)),
    balance: 12,
    available: 12,
  }

  const pad = (s, w) => String(s ?? '—').padEnd(w)
  const rpad = (s, w) => String(s ?? '—').padStart(w)

  const header = [
    pad('Institution', colWidths.institution),
    pad('Account', colWidths.name),
    pad('Type', colWidths.type),
    rpad('Balance', colWidths.balance),
    rpad('Available', colWidths.available),
  ].join('  ')

  console.log(header)
  console.log('-'.repeat(header.length))

  for (const a of allAccounts) {
    const fmt = (v) => (v != null ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—')
    console.log([
      pad(a.institution, colWidths.institution),
      pad(a.name, colWidths.name),
      pad(a.type, colWidths.type),
      rpad(fmt(a.balance), colWidths.balance),
      rpad(fmt(a.available), colWidths.available),
    ].join('  '))
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
