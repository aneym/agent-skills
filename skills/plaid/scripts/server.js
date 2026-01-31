#!/usr/bin/env node

import express from 'express'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { plaidClient, Products, CountryCode } from './lib/plaid-client.js'
import { addToken, readTokens, writeTokens } from './lib/tokens.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = 3456

app.use(express.json())

app.get('/', async (_req, res) => {
  const html = await readFile(join(__dirname, '..', 'assets', 'link.html'), 'utf-8')
  res.type('html').send(html)
})

app.get('/api/accounts', async (_req, res) => {
  const tokens = await readTokens()
  const items = tokens.map(t => ({
    item_id: t.item_id,
    institution_name: t.institution_name,
    accounts: t.accounts,
    connected_at: t.connected_at,
  }))
  res.json({ items })
})

app.post('/api/create-link-token', async (_req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'openclaw-user' },
      client_name: 'OpenClaw Plaid Skill',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    res.json({ link_token: response.data.link_token })
  } catch (err) {
    console.error('linkTokenCreate error:', err.response?.data || err.message)
    res.status(500).json({ error: err.response?.data?.error_message || err.message })
  }
})

app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token, institution_name } = req.body

    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token })
    const { access_token, item_id } = exchangeRes.data

    const accountsRes = await plaidClient.accountsGet({ access_token })
    const accounts = accountsRes.data.accounts.map((a) => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
    }))

    await addToken({
      access_token,
      item_id,
      institution_name: institution_name || 'Unknown',
      accounts,
      connected_at: new Date().toISOString(),
    })

    console.log(`Connected: ${institution_name} (${accounts.length} accounts)`)
    res.json({ success: true, accounts })
  } catch (err) {
    console.error('exchange error:', err.response?.data || err.message)
    res.status(500).json({ error: err.response?.data?.error_message || err.message })
  }
})

app.delete('/api/accounts/:item_id', async (req, res) => {
  try {
    const { item_id } = req.params
    const tokens = await readTokens()
    const token = tokens.find(t => t.item_id === item_id)
    if (!token) return res.status(404).json({ error: 'Item not found' })

    // Remove from Plaid
    try {
      await plaidClient.itemRemove({ access_token: token.access_token })
    } catch (e) {
      console.warn('Plaid itemRemove failed (may already be removed):', e.message)
    }

    // Remove from local state
    const updated = tokens.filter(t => t.item_id !== item_id)
    await writeTokens(updated)
    console.log(`Removed: ${token.institution_name}`)
    res.json({ success: true })
  } catch (err) {
    console.error('remove error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Plaid Link server running at http://localhost:${PORT}`)
  console.log('Open the URL above to connect and manage bank accounts.')
})
