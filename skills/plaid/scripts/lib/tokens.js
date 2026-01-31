import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function resolveTokensPath() {
  if (process.env.PLAID_TOKENS_PATH) return process.env.PLAID_TOKENS_PATH
  const workspace = process.env.OPENCLAW_WORKSPACE || process.cwd()
  return join(workspace, 'state', 'plaid-tokens.json')
}

const TOKENS_PATH = resolveTokensPath()

export async function readTokens() {
  try {
    const data = await readFile(TOKENS_PATH, 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export async function writeTokens(tokens) {
  await mkdir(dirname(TOKENS_PATH), { recursive: true })
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2) + '\n')
}

export async function addToken(tokenData) {
  const tokens = await readTokens()
  tokens.push(tokenData)
  await writeTokens(tokens)
  return tokens
}
