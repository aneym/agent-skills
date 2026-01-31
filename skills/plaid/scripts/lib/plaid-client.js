import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

const clientId = process.env.PLAID_CLIENT_ID
const secret = process.env.PLAID_SECRET
const env = process.env.PLAID_ENV || 'sandbox'

if (!clientId || !secret) {
  console.error('Error: PLAID_CLIENT_ID and PLAID_SECRET environment variables are required.')
  process.exit(1)
}

const configuration = new Configuration({
  basePath: PlaidEnvironments[env],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': clientId,
      'PLAID-SECRET': secret,
    },
  },
})

export const plaidClient = new PlaidApi(configuration)
export { Products, CountryCode } from 'plaid'
