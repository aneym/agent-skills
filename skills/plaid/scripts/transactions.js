#!/usr/bin/env node

import { plaidClient } from './lib/plaid-client.js'
import { readTokens } from './lib/tokens.js'

function parseArgs(argv) {
  const args = argv.slice(2)
  const opts = { days: 30, search: null, category: null, account: null, json: false }
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--days': opts.days = parseInt(args[++i], 10); break
      case '--search': opts.search = args[++i]?.toLowerCase(); break
      case '--category': opts.category = args[++i]?.toLowerCase(); break
      case '--account': opts.account = args[++i]?.toLowerCase(); break
      case '--json': opts.json = true; break
    }
  }
  return opts
}

function dateStr(daysAgo) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

async function main() {
  const opts = parseArgs(process.argv)
  const tokens = await readTokens()

  if (tokens.length === 0) {
    console.error('No connected accounts. Run server.js first to connect a bank.')
    process.exit(1)
  }

  const startDate = dateStr(opts.days)
  const endDate = dateStr(0)
  const allTxns = []

  for (const item of tokens) {
    // Build account name lookup
    const acctMap = Object.fromEntries(item.accounts.map((a) => [a.id, a.name]))

    try {
      let hasMore = true
      let cursor = undefined

      while (hasMore) {
        const res = await plaidClient.transactionsSync({
          access_token: item.access_token,
          cursor,
          count: 500,
        })
        const { added, has_more, next_cursor } = res.data

        for (const txn of added) {
          const txnDate = txn.date
          if (txnDate < startDate || txnDate > endDate) continue

          const accountName = acctMap[txn.account_id] || 'Unknown'

          // Apply filters
          if (opts.account && !accountName.toLowerCase().includes(opts.account)) continue
          if (opts.search && !(txn.merchant_name || txn.name || '').toLowerCase().includes(opts.search)) continue
          if (opts.category) {
            const cats = (txn.personal_finance_category?.primary || txn.category?.join(', ') || '').toLowerCase()
            if (!cats.includes(opts.category)) continue
          }

          allTxns.push({
            date: txnDate,
            account: accountName,
            institution: item.institution_name,
            merchant: txn.merchant_name || txn.name || '—',
            category: txn.personal_finance_category?.primary || txn.category?.join(', ') || '—',
            amount: txn.amount,
          })
        }

        hasMore = has_more
        cursor = next_cursor
      }
    } catch (err) {
      console.error(`Error fetching ${item.institution_name}: ${err.response?.data?.error_message || err.message}`)
    }
  }

  // Sort by date descending
  allTxns.sort((a, b) => b.date.localeCompare(a.date))

  if (opts.json) {
    console.log(JSON.stringify(allTxns, null, 2))
    return
  }

  if (allTxns.length === 0) {
    console.log('No transactions found.')
    return
  }

  // Table output
  const colWidths = {
    date: 10,
    account: Math.max(7, ...allTxns.map((t) => t.account.length)),
    merchant: Math.min(30, Math.max(8, ...allTxns.map((t) => t.merchant.length))),
    category: Math.min(20, Math.max(8, ...allTxns.map((t) => t.category.length))),
    amount: 12,
  }

  const pad = (s, w) => String(s).slice(0, w).padEnd(w)
  const rpad = (s, w) => String(s).padStart(w)

  const header = [
    pad('Date', colWidths.date),
    pad('Account', colWidths.account),
    pad('Merchant', colWidths.merchant),
    pad('Category', colWidths.category),
    rpad('Amount', colWidths.amount),
  ].join('  ')

  console.log(header)
  console.log('-'.repeat(header.length))

  for (const t of allTxns) {
    const amt = t.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    console.log([
      pad(t.date, colWidths.date),
      pad(t.account, colWidths.account),
      pad(t.merchant, colWidths.merchant),
      pad(t.category, colWidths.category),
      rpad(amt, colWidths.amount),
    ].join('  '))
  }

  console.log(`\n${allTxns.length} transactions (${opts.days} days)`)
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
