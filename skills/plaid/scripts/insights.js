#!/usr/bin/env node

import { plaidClient } from './lib/plaid-client.js'
import { readTokens } from './lib/tokens.js'

function parseArgs(argv) {
  const args = argv.slice(2)
  const opts = { days: 30, json: false }
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--days': opts.days = parseInt(args[++i], 10); break
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

function fmt(v) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function pct(part, whole) {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '0%'
}

async function fetchTransactions(tokens, startDate, endDate) {
  const all = []
  for (const item of tokens) {
    const acctMap = Object.fromEntries(item.accounts.map(a => [a.id, a.name]))
    try {
      let hasMore = true, cursor
      while (hasMore) {
        const res = await plaidClient.transactionsSync({ access_token: item.access_token, cursor, count: 500 })
        for (const txn of res.data.added) {
          if (txn.date < startDate || txn.date > endDate) continue
          all.push({
            date: txn.date,
            account: acctMap[txn.account_id] || 'Unknown',
            institution: item.institution_name,
            merchant: txn.merchant_name || txn.name || '—',
            category: txn.personal_finance_category?.primary || txn.category?.join(', ') || '—',
            amount: txn.amount,
          })
        }
        hasMore = res.data.has_more
        cursor = res.data.next_cursor
      }
    } catch (err) {
      console.error(`Error fetching ${item.institution_name}: ${err.response?.data?.error_message || err.message}`)
    }
  }
  return all
}

async function fetchBalances(tokens) {
  const all = []
  for (const item of tokens) {
    try {
      const res = await plaidClient.accountsGet({ access_token: item.access_token })
      for (const acct of res.data.accounts) {
        all.push({
          institution: item.institution_name,
          name: acct.name,
          type: acct.subtype || acct.type,
          balance: acct.balances.current,
          available: acct.balances.available,
          limit: acct.balances.limit,
        })
      }
    } catch (err) {
      console.error(`Error: ${err.response?.data?.error_message || err.message}`)
    }
  }
  return all
}

function analyze(txns, balances, days) {
  const INTERNAL = ['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']
  const spend = txns.filter(t => !INTERNAL.includes(t.category) && t.amount > 0)
  const income = txns.filter(t => t.category === 'INCOME')

  const totalIncome = income.reduce((s, t) => s + Math.abs(t.amount), 0)
  const totalSpend = spend.reduce((s, t) => s + t.amount, 0)
  const activeDays = new Set(spend.map(t => t.date)).size || 1

  // Category breakdown
  const byCat = {}
  spend.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount })

  // Merchant breakdown
  const byMerchant = {}
  const merchantCount = {}
  spend.forEach(t => {
    byMerchant[t.merchant] = (byMerchant[t.merchant] || 0) + t.amount
    merchantCount[t.merchant] = (merchantCount[t.merchant] || 0) + 1
  })

  // Card breakdown
  const byCard = {}
  spend.forEach(t => {
    const key = `${t.institution} — ${t.account}`
    byCard[key] = (byCard[key] || 0) + t.amount
  })

  // Recurring detection (3+ hits)
  const recurring = Object.entries(merchantCount)
    .filter(([, c]) => c >= 3)
    .map(([m, count]) => ({ merchant: m, count, total: byMerchant[m], avg: byMerchant[m] / count }))
    .sort((a, b) => b.total - a.total)

  // Balance summary
  const cashAccounts = balances.filter(b => ['checking', 'savings'].includes(b.type))
  const creditCards = balances.filter(b => b.type === 'credit card')
  const totalCash = cashAccounts.reduce((s, a) => s + (a.balance || 0), 0)
  const totalCreditBalance = creditCards.reduce((s, a) => s + (a.balance || 0), 0)
  const totalCreditLimit = creditCards.reduce((s, a) => s + (a.limit || a.available || 0), 0)

  return {
    period: { days, activeDays },
    summary: { totalIncome, totalSpend, net: totalIncome - totalSpend, savingsRate: pct(totalIncome - totalSpend, totalIncome) },
    daily: { avgSpend: totalSpend / activeDays, avgIncome: totalIncome / days },
    annualized: { income: totalIncome * (365 / days), spend: totalSpend * (365 / days) },
    categories: Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => ({ category: cat, amount: amt, pct: pct(amt, totalSpend) })),
    topMerchants: Object.entries(byMerchant).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([m, amt]) => ({ merchant: m, amount: amt, count: merchantCount[m] })),
    recurring,
    cardUsage: Object.entries(byCard).sort((a, b) => b[1] - a[1]).map(([card, amt]) => ({ card, amount: amt, pct: pct(amt, totalSpend) })),
    balances: { totalCash, totalCreditBalance, totalCreditLimit, utilization: pct(totalCreditBalance, totalCreditLimit) },
    txnCount: spend.length,
  }
}

function printReport(r) {
  const line = (label, val) => console.log(`  ${label.padEnd(28)} ${val}`)
  const divider = () => console.log()

  console.log(`\n══════════════════════════════════════════`)
  console.log(`  FINANCIAL INSIGHTS — ${r.period.days} DAYS`)
  console.log(`══════════════════════════════════════════`)
  divider()

  console.log('CASH FLOW')
  line('Income', fmt(r.summary.totalIncome))
  line('Spending', fmt(r.summary.totalSpend))
  line('Net', fmt(r.summary.net))
  line('Savings Rate', r.summary.savingsRate)
  line('Avg Daily Spend', fmt(r.daily.avgSpend))
  line('Annualized Income', fmt(r.annualized.income))
  line('Annualized Spend', fmt(r.annualized.spend))
  divider()

  console.log('BALANCES')
  line('Cash (checking+savings)', fmt(r.balances.totalCash))
  line('Credit Card Balances', fmt(r.balances.totalCreditBalance))
  line('Total Credit Limit', fmt(r.balances.totalCreditLimit))
  line('Credit Utilization', r.balances.utilization)
  divider()

  console.log('SPENDING BY CATEGORY')
  r.categories.forEach(c => {
    const label = c.category.toLowerCase().replace(/_/g, ' ')
    line(`${label}`, `${fmt(c.amount).padStart(10)}  (${c.pct})`)
  })
  divider()

  console.log('TOP MERCHANTS')
  r.topMerchants.forEach(m => {
    line(`${m.merchant.slice(0, 26)}`, `${fmt(m.amount).padStart(10)}  (${m.count}x)`)
  })
  divider()

  if (r.recurring.length) {
    console.log('RECURRING / SUBSCRIPTIONS (3+ charges)')
    r.recurring.forEach(s => {
      line(`${s.merchant.slice(0, 26)}`, `${fmt(s.total).padStart(10)}  ${s.count}x @ ${fmt(s.avg)} avg`)
    })
    divider()
  }

  console.log('SPEND BY CARD')
  r.cardUsage.forEach(c => {
    line(`${c.card.slice(0, 26)}`, `${fmt(c.amount).padStart(10)}  (${c.pct})`)
  })

  console.log(`\n  ${r.txnCount} transactions across ${r.period.activeDays} days`)
  console.log(`══════════════════════════════════════════\n`)
}

async function main() {
  const opts = parseArgs(process.argv)
  const tokens = await readTokens()
  if (tokens.length === 0) {
    console.error('No connected accounts. Run server.js first.')
    process.exit(1)
  }

  const startDate = dateStr(opts.days)
  const endDate = dateStr(0)

  const [txns, balances] = await Promise.all([
    fetchTransactions(tokens, startDate, endDate),
    fetchBalances(tokens),
  ])

  const report = analyze(txns, balances, opts.days)

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report)
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
