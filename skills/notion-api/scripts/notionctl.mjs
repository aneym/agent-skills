#!/usr/bin/env node
/**
 * notionctl.mjs - v2.0
 *
 * Comprehensive Notion API CLI with rich markdown support:
 * - Native table blocks (markdown → Notion tables)
 * - Callout blocks (GitHub-style admonitions with icons)
 * - Toggle blocks (<details> → Notion toggles)
 * - Full inline formatting (bold, italic, strikethrough, code, links, colors)
 * - Nested lists (proper indentation handling)
 * - Image blocks
 * - New commands: update-page, delete-block, get-blocks, update-block
 *
 * Always uses Notion-Version 2025-09-03
 * No external deps (Node 18+ fetch)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2025-09-03";
const MIN_INTERVAL_MS = 350;
const MAX_RETRIES = 6;
const MAX_BLOCKS_PER_APPEND = 100;
const DEFAULT_PAGE_SIZE = 100;

let nextAllowedAt = 0;

/** ---------- utilities ---------- **/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function compactJson(x) {
  return JSON.stringify(x);
}

function prettyJson(x) {
  return JSON.stringify(x, null, 2);
}

function print(obj, { compact = false } = {}) {
  process.stdout.write((compact ? compactJson(obj) : prettyJson(obj)) + "\n");
}

function fail(message, { code = 1, details } = {}) {
  const err = { ok: false, error: message };
  if (details !== undefined) err.details = details;
  print(err, { compact: false });
  process.exit(code);
}

function usage() {
  const msg = `
notionctl v2.0 — Notion API CLI for agents (JSON-first, rich markdown support)

Usage:
  notionctl whoami
  notionctl search --query "text" [--type page|data_source|all] [--limit 20]
  notionctl get-page --page "<id-or-url>"
  notionctl get-blocks --page "<id-or-url>"
  notionctl export-md --page "<id-or-url>" [--stdout-md]
  notionctl create-md --title "Title" (--parent-page "<id-or-url>" | --parent-data-source "<id-or-url>") (--md "..." | --md-file path | --md-stdin)
                [--set "Prop=Value" ...]
                [--template none|default | --template-id "<id-or-url>"]
                [--position page_start|page_end | --after-block "<id-or-url>"]
  notionctl append-md --page "<id-or-url>" (--md "..." | --md-file path | --md-stdin)
  notionctl update-page --page "<id-or-url>" [--title "New Title"] [--set "Prop=Value" ...]
  notionctl update-block --block "<id-or-url>" (--md "..." | --md-file path | --md-stdin)
  notionctl delete-block --block "<id-or-url>"
  notionctl move --page "<id-or-url>" (--to-page "<id-or-url>" | --to-data-source "<id-or-url>")
  notionctl list-child-pages --page "<id-or-url>"
  notionctl triage --inbox-page "<id-or-url>" --rules "<json-file>" [--limit 50] [--apply]

Common flags:
  --compact        output single-line JSON
  --help           show help

Environment:
  NOTION_API_KEY (preferred)
  NOTION_TOKEN / NOTION_API_TOKEN (fallbacks)

Local fallback:
  ~/.config/notion/api_key

New in v2.0:
  • Full inline formatting: **bold**, *italic*, ~~strike~~, \`code\`, [links](url)
  • Native tables: markdown pipes → Notion table blocks
  • Callouts: > [!NOTE], > [!TIP], > [!WARNING] → colored callout blocks
  • Toggles: <details> → Notion toggle blocks
  • Images: ![alt](url) → image blocks
  • Nested lists: proper indentation handling
  • New commands: update-page, update-block, delete-block, get-blocks
  • Colors: support for text and background colors

Notes:
  - All requests use Notion-Version: ${NOTION_VERSION}.
  - export-md preserves rich formatting where possible.
`.trim();
  process.stdout.write(msg + "\n");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      const k = tok.slice(2, eq);
      const v = tok.slice(eq + 1);
      pushFlag(out, k, v);
      continue;
    }
    const k = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      pushFlag(out, k, true);
    } else {
      pushFlag(out, k, next);
      i++;
    }
  }
  return out;
}

function pushFlag(obj, key, value) {
  if (obj[key] === undefined) {
    obj[key] = value;
  } else if (Array.isArray(obj[key])) {
    obj[key].push(value);
  } else {
    obj[key] = [obj[key], value];
  }
}

function resolveHome(p) {
  if (!p) return p;
  if (p.startsWith("~" + path.sep) || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** ---------- Notion IDs ---------- **/

function toDashedUuid(hex32) {
  const s = hex32.toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function normaliseId(idOrUrl) {
  if (!idOrUrl || typeof idOrUrl !== "string") throw new Error("Missing ID/URL");
  const s = idOrUrl.trim();
  const dashed = s.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (dashed) return dashed[0].toLowerCase();
  const hex32 = s.match(/[0-9a-fA-F]{32}/);
  if (hex32) return toDashedUuid(hex32[0]);
  throw new Error(`Could not extract a Notion UUID from: ${idOrUrl}`);
}

/** ---------- auth ---------- **/

function readTokenFromEnv() {
  return (
    process.env.NOTION_API_KEY ||
    process.env.NOTION_TOKEN ||
    process.env.NOTION_API_TOKEN ||
    ""
  ).trim();
}

function readTokenFromFile() {
  const p = resolveHome(path.join("~", ".config", "notion", "api_key"));
  try {
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function getToken() {
  const env = readTokenFromEnv();
  if (env) return env;
  const file = readTokenFromFile();
  if (file) return file;
  throw new Error(
    "Missing Notion token. Set NOTION_API_KEY (recommended) or create ~/.config/notion/api_key"
  );
}

/** ---------- HTTP ---------- **/

function buildHeaders(token, { hasBody = false } = {}) {
  const h = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    Accept: "application/json",
  };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

async function throttle() {
  const t = nowMs();
  if (t < nextAllowedAt) await sleep(nextAllowedAt - t);
  nextAllowedAt = nowMs() + MIN_INTERVAL_MS;
}

async function notionRequest({ method, path, query, body }) {
  const token = getToken();
  const url = new URL(NOTION_API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const hasBody = body !== undefined && body !== null;
  const init = {
    method,
    headers: buildHeaders(token, { hasBody }),
  };
  if (hasBody) init.body = JSON.stringify(body);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const res = await fetch(url, init);

    if (res.ok) {
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    let errBody = null;
    try {
      errBody = await res.json();
    } catch {
      try {
        errBody = await res.text();
      } catch {
        errBody = null;
      }
    }

    const status = res.status;

    if (status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const waitSec = retryAfter ? Number.parseFloat(retryAfter) : NaN;
      const waitMs = Number.isFinite(waitSec) ? Math.max(0, waitSec) * 1000 : 1000 * Math.pow(2, attempt);
      await sleep(waitMs);
      continue;
    }

    if ((status === 500 || status === 502 || status === 503 || status === 504) && attempt < MAX_RETRIES) {
      const waitMs = 500 * Math.pow(2, attempt);
      await sleep(waitMs);
      continue;
    }

    const msg = isObject(errBody) && typeof errBody.message === "string"
      ? errBody.message
      : `HTTP ${status}`;
    const code = isObject(errBody) ? errBody.code : undefined;
    const error = { status, code, message: msg, body: errBody };
    throw new Error(prettyJson(error));
  }

  throw new Error("Request failed after retries");
}

/** ---------- Notion helpers ---------- **/

function getPageTitle(page) {
  if (!page || !isObject(page)) return null;
  const props = page.properties;
  if (!isObject(props)) return null;

  for (const [name, prop] of Object.entries(props)) {
    if (isObject(prop) && prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? "").join("");
    }
  }

  const direct = props.title;
  if (isObject(direct) && direct.type === "title" && Array.isArray(direct.title)) {
    return direct.title.map((t) => t.plain_text ?? "").join("");
  }

  return null;
}

function escapeMd(text) {
  return String(text).replace(/\\/g, "\\\\");
}

function applyAnnotations(text, ann) {
  if (!ann || !isObject(ann)) return text;
  let out = text;
  if (ann.code) out = "`" + out.replace(/`/g, "\\`") + "`";
  if (ann.bold) out = "**" + out + "**";
  if (ann.italic) out = "*" + out + "*";
  if (ann.strikethrough) out = "~~" + out + "~~";
  if (ann.underline) out = "<u>" + out + "</u>";
  return out;
}

function richTextToMarkdown(richText) {
  if (!Array.isArray(richText) || richText.length === 0) return "";
  return richText
    .map((rt) => {
      if (!isObject(rt)) return "";
      const ann = rt.annotations;
      const plain = rt.plain_text ?? "";
      let txt = escapeMd(plain);

      const url = (rt.type === "text" && rt.text && rt.text.link && rt.text.link.url) ? rt.text.link.url : rt.href;
      txt = applyAnnotations(txt, ann);
      if (url) txt = `[${txt}](${url})`;

      return txt;
    })
    .join("");
}

/** ---------- Rich text parsing (inline formatting) ---------- **/

function parseInlineFormatting(text) {
  // Parse markdown inline formatting: **bold**, *italic*, ~~strike~~, `code`, [text](url)
  // Returns array of rich text objects with proper annotations
  
  const parts = [];
  let i = 0;
  const s = String(text ?? "");
  
  while (i < s.length) {
    // Try to match patterns in order of specificity
    
    // Code (must come before bold/italic to avoid conflicts)
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) {
        const code = s.slice(i + 1, end);
        parts.push({
          type: "text",
          text: { content: code },
          annotations: { code: true, bold: false, italic: false, strikethrough: false, underline: false, color: "default" }
        });
        i = end + 1;
        continue;
      }
    }
    
    // Links: [text](url)
    if (s[i] === '[') {
      const textEnd = s.indexOf('](', i + 1);
      if (textEnd !== -1) {
        const urlEnd = s.indexOf(')', textEnd + 2);
        if (urlEnd !== -1) {
          const linkText = s.slice(i + 1, textEnd);
          const url = s.slice(textEnd + 2, urlEnd);
          // Parse formatting within link text
          const linkParts = parseInlineFormatting(linkText);
          for (const part of linkParts) {
            part.text.link = { url };
          }
          parts.push(...linkParts);
          i = urlEnd + 1;
          continue;
        }
      }
    }
    
    // Bold: **text**
    if (s.slice(i, i + 2) === '**') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1) {
        const bold = s.slice(i + 2, end);
        // Recursively parse inside bold for italic/strike
        const innerParts = parseInlineFormatting(bold);
        for (const part of innerParts) {
          part.annotations.bold = true;
        }
        parts.push(...innerParts);
        i = end + 2;
        continue;
      }
    }
    
    // Strikethrough: ~~text~~
    if (s.slice(i, i + 2) === '~~') {
      const end = s.indexOf('~~', i + 2);
      if (end !== -1) {
        const strike = s.slice(i + 2, end);
        const innerParts = parseInlineFormatting(strike);
        for (const part of innerParts) {
          part.annotations.strikethrough = true;
        }
        parts.push(...innerParts);
        i = end + 2;
        continue;
      }
    }
    
    // Italic: *text* (single asterisk or underscore)
    if (s[i] === '*' || s[i] === '_') {
      const char = s[i];
      const end = s.indexOf(char, i + 1);
      if (end !== -1 && s[end - 1] !== '\\') {
        const italic = s.slice(i + 1, end);
        const innerParts = parseInlineFormatting(italic);
        for (const part of innerParts) {
          part.annotations.italic = true;
        }
        parts.push(...innerParts);
        i = end + 1;
        continue;
      }
    }
    
    // Plain text: accumulate until next special char
    let j = i;
    while (j < s.length) {
      const c = s[j];
      if (c === '`' || c === '[' || c === '*' || c === '_' || c === '~') break;
      j++;
    }
    
    if (j > i) {
      const plain = s.slice(i, j);
      if (plain) {
        parts.push({
          type: "text",
          text: { content: plain },
          annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }
        });
      }
      i = j;
    } else {
      // Single char that didn't match a pattern
      parts.push({
        type: "text",
        text: { content: s[i] },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }
      });
      i++;
    }
  }
  
  // Merge adjacent plain text parts
  const merged = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && 
        !last.text.link && !part.text.link &&
        JSON.stringify(last.annotations) === JSON.stringify(part.annotations)) {
      last.text.content += part.text.content;
    } else {
      merged.push(part);
    }
  }
  
  // Split long text segments (Notion has 2000 char limit per text object)
  const final = [];
  for (const part of merged) {
    const content = part.text.content;
    if (content.length <= 2000) {
      final.push(part);
    } else {
      for (let i = 0; i < content.length; i += 2000) {
        final.push({
          ...part,
          text: {
            ...part.text,
            content: content.slice(i, i + 2000)
          }
        });
      }
    }
  }
  
  return final.length > 0 ? final : [{
    type: "text",
    text: { content: "" },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }
  }];
}

function textToRichText(text) {
  // Simple version for plain text (backwards compatibility)
  const s = String(text ?? "");
  const out = [];
  for (let i = 0; i < s.length; i += 2000) {
    out.push({
      type: "text",
      text: { content: s.slice(i, i + 2000) },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }
    });
  }
  return out.length > 0 ? out : [{
    type: "text",
    text: { content: "" },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }
  }];
}

/** ---------- Blocks: fetch + markdown export ---------- **/

async function listBlockChildren(blockId) {
  const id = normaliseId(blockId);
  const results = [];
  let cursor = undefined;
  while (true) {
    const q = { page_size: DEFAULT_PAGE_SIZE };
    if (cursor) q.start_cursor = cursor;

    const res = await notionRequest({
      method: "GET",
      path: `/v1/blocks/${id}/children`,
      query: q,
    });

    if (res && Array.isArray(res.results)) results.push(...res.results);
    if (!res || !res.has_more) break;
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return results;
}

async function getBlockTree(blockId, { maxDepth = 50, depth = 0 } = {}) {
  const blocks = await listBlockChildren(blockId);
  if (depth >= maxDepth) return blocks;

  for (const b of blocks) {
    if (b && b.has_children) {
      b.children = await getBlockTree(b.id, { maxDepth, depth: depth + 1 });
    }
  }
  return blocks;
}

function blockToMarkdown(block, indent = 0) {
  const pad = " ".repeat(indent);
  const type = block.type;
  const obj = block[type] || {};

  const rt = isObject(obj) && Array.isArray(obj.rich_text) ? obj.rich_text : [];
  const txt = richTextToMarkdown(rt);

  const children = Array.isArray(block.children) ? block.children : [];

  const renderChildren = (childIndent) => {
    if (!children.length) return "";
    const parts = children.map((c) => blockToMarkdown(c, childIndent)).filter(Boolean);
    const joined = parts.join("\n");
    return joined ? "\n" + joined : "";
  };

  switch (type) {
    case "paragraph": {
      const line = txt ? pad + txt : "";
      return (line + renderChildren(indent)).trimEnd();
    }
    case "heading_1":
      return (pad + "# " + txt).trimEnd() + renderChildren(indent);
    case "heading_2":
      return (pad + "## " + txt).trimEnd() + renderChildren(indent);
    case "heading_3":
      return (pad + "### " + txt).trimEnd() + renderChildren(indent);
    case "bulleted_list_item": {
      const line = pad + "- " + txt;
      return (line + renderChildren(indent + 2)).trimEnd();
    }
    case "numbered_list_item": {
      const line = pad + "1. " + txt;
      return (line + renderChildren(indent + 3)).trimEnd();
    }
    case "to_do": {
      const checked = !!obj.checked;
      const line = pad + `- [${checked ? "x" : " "}] ` + txt;
      return (line + renderChildren(indent + 2)).trimEnd();
    }
    case "quote": {
      const line = pad + "> " + txt;
      return (line + renderChildren(indent)).trimEnd();
    }
    case "code": {
      const lang = obj.language || "";
      const codeText = (Array.isArray(obj.rich_text) ? obj.rich_text.map((t) => t.plain_text ?? "").join("") : "");
      return `${pad}\`\`\`${lang}\n${codeText}\n${pad}\`\`\``;
    }
    case "divider":
      return pad + "---";
    case "callout": {
      const icon = block.icon && block.icon.type === "emoji" ? block.icon.emoji : "💡";
      const color = obj.color || "default";
      // Export as GitHub-style admonition
      let prefix = "NOTE";
      if (color.includes("yellow") || color.includes("orange")) prefix = "WARNING";
      if (color.includes("red")) prefix = "IMPORTANT";
      if (color.includes("blue")) prefix = "TIP";
      const line = pad + `> [!${prefix}] ${icon}`;
      const content = txt ? "\n" + pad + "> " + txt : "";
      return (line + content + renderChildren(indent)).trimEnd();
    }
    case "toggle": {
      const summary = txt || "Details";
      const inner = children.map((c) => blockToMarkdown(c, indent + 2)).filter(Boolean).join("\n");
      return `${pad}<details>\n${pad}<summary>${summary}</summary>\n\n${inner}\n\n${pad}</details>`;
    }
    case "table": {
      // Export as markdown table
      const rows = children.filter(c => c.type === "table_row");
      if (rows.length === 0) return "";
      
      const hasHeader = obj.has_column_header;
      const cells = rows.map(r => {
        const rowCells = r.table_row?.cells || [];
        return rowCells.map(cell => richTextToMarkdown(cell));
      });
      
      if (cells.length === 0) return "";
      const width = cells[0].length;
      
      let md = "";
      cells.forEach((row, i) => {
        md += pad + "| " + row.join(" | ") + " |\n";
        if (i === 0 && hasHeader) {
          md += pad + "|" + " --- |".repeat(width) + "\n";
        }
      });
      return md.trimEnd();
    }
    case "image": {
      const url = obj.external?.url || obj.file?.url || "";
      const caption = Array.isArray(obj.caption) ? richTextToMarkdown(obj.caption) : "";
      return pad + `![${caption}](${url})`;
    }
    case "child_page": {
      const title = obj.title || "Untitled";
      return `${pad}- ${title} (child page: ${block.id})`;
    }
    default: {
      if (txt) return (pad + txt + renderChildren(indent)).trimEnd();
      return `${pad}<!-- Unsupported block type: ${type} (${block.id}) -->`;
    }
  }
}

function blocksToMarkdown(blocks) {
  const parts = blocks.map((b) => blockToMarkdown(b, 0)).filter(Boolean);
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** ---------- Advanced Markdown Parser ---------- **/

function parseMarkdownTable(lines, startIdx) {
  // Parse markdown table: | Header | Header | ... |
  const rows = [];
  let i = startIdx;
  
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    
    // Skip separator line (|---|---|)
    if (/^\|[\s:-]+\|/.test(line)) {
      i++;
      continue;
    }
    
    const cells = line.split('|')
      .map(c => c.trim())
      .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1); // Remove empty first/last
    
    if (cells.length > 0) {
      rows.push(cells);
    }
    i++;
  }
  
  if (rows.length === 0) return null;
  
  const width = rows[0].length;
  const headers = rows[0];
  const dataRows = rows.slice(1);
  
  // Build table block with children
  const tableRows = [
    {
      type: "table_row",
      table_row: {
        cells: headers.map(h => parseInlineFormatting(h))
      }
    },
    ...dataRows.map(row => ({
      type: "table_row",
      table_row: {
        cells: row.map(cell => parseInlineFormatting(cell))
      }
    }))
  ];
  
  return {
    block: {
      type: "table",
      table: {
        table_width: width,
        has_column_header: true,
        has_row_header: false,
        children: tableRows
      }
    },
    linesConsumed: i - startIdx
  };
}

function parseCallout(lines, startIdx) {
  // Parse GitHub-style admonition: > [!NOTE] or > [!TIP] etc.
  const firstLine = lines[startIdx];
  const match = firstLine.match(/^>\s*\[!(\w+)\]\s*(.*)/);
  if (!match) return null;
  
  const [, admonition, text] = match;
  
  // Map admonition types to Notion callout colors and emojis
  const mapping = {
    NOTE: { emoji: "📝", color: "blue_background" },
    TIP: { emoji: "💡", color: "green_background" },
    IMPORTANT: { emoji: "❗", color: "red_background" },
    WARNING: { emoji: "⚠️", color: "yellow_background" },
    CAUTION: { emoji: "⚠️", color: "orange_background" },
  };
  
  const config = mapping[admonition.toUpperCase()] || { emoji: "💭", color: "gray_background" };
  
  // Collect subsequent quote lines
  const content = [text];
  let i = startIdx + 1;
  while (i < lines.length && lines[i].startsWith('>')) {
    const line = lines[i].replace(/^>\s?/, '');
    if (line) content.push(line);
    i++;
  }
  
  return {
    block: {
      type: "callout",
      callout: {
        rich_text: parseInlineFormatting(content.join(' ')),
        icon: { type: "emoji", emoji: config.emoji },
        color: config.color
      }
    },
    linesConsumed: i - startIdx
  };
}

function parseToggle(lines, startIdx) {
  // Parse HTML details tag: <details><summary>...</summary>content</details>
  const firstLine = lines[startIdx];
  if (!firstLine.trim().startsWith('<details>')) return null;
  
  let summary = "";
  let content = [];
  let i = startIdx;
  let inDetails = true;
  
  while (i < lines.length && inDetails) {
    const line = lines[i];
    
    if (line.includes('<summary>')) {
      const summaryMatch = line.match(/<summary>(.*?)<\/summary>/);
      if (summaryMatch) {
        summary = summaryMatch[1];
      }
    } else if (line.includes('</details>')) {
      inDetails = false;
    } else if (!line.includes('<details>') && !line.includes('<summary>')) {
      const cleaned = line.trim();
      if (cleaned) content.push(cleaned);
    }
    
    i++;
  }
  
  // Parse content as markdown blocks
  const innerBlocks = parseMarkdownToBlocks(content.join('\n'));
  
  return {
    block: {
      type: "toggle",
      toggle: {
        rich_text: parseInlineFormatting(summary || "Toggle"),
        children: innerBlocks
      }
    },
    linesConsumed: i - startIdx
  };
}

function parseNestedList(lines, startIdx, baseIndent = 0) {
  // Parse nested lists by tracking indentation
  const items = [];
  let i = startIdx;
  
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (!match) break;
    
    const [, indent, marker, text] = match;
    const currentIndent = indent.length;
    
    // If less indented than base, we're done with this level
    if (currentIndent < baseIndent) break;
    
    // If more indented than base, this belongs to a child
    if (currentIndent > baseIndent) {
      // This should be handled by the parent item's children parsing
      break;
    }
    
    // Same level - parse this item
    const isBulleted = marker === '-' || marker === '*';
    const isNumbered = /^\d+\.$/.test(marker);
    const isTodo = text.match(/^\[([ xX])\]\s+(.+)$/);
    
    let itemText = text;
    let checked = false;
    
    if (isTodo) {
      checked = isTodo[1].toLowerCase() === 'x';
      itemText = isTodo[2];
    }
    
    // Look ahead for children (more indented items)
    const children = [];
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j];
      const nextMatch = nextLine.match(/^(\s*)([-*]|\d+\.)\s+/);
      if (!nextMatch) {
        j++;
        continue;
      }
      const nextIndent = nextMatch[1].length;
      if (nextIndent > currentIndent) {
        // Parse nested list recursively
        const nested = parseNestedList(lines, j, nextIndent);
        children.push(...nested.items);
        j = nested.endIndex;
      } else {
        break;
      }
    }
    
    const blockType = isTodo ? "to_do" : (isBulleted ? "bulleted_list_item" : "numbered_list_item");
    const block = {
      type: blockType,
      [blockType]: {
        rich_text: parseInlineFormatting(itemText)
      }
    };
    
    if (isTodo) {
      block[blockType].checked = checked;
    }
    
    if (children.length > 0) {
      block[blockType].children = children;
    }
    
    items.push(block);
    i = j > i + 1 ? j : i + 1;
  }
  
  return { items, endIndex: i };
}

function parseMarkdownToBlocks(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Tables
    if (line.trim().startsWith('|')) {
      const table = parseMarkdownTable(lines, i);
      if (table) {
        blocks.push(table.block);
        i += table.linesConsumed;
        continue;
      }
    }

    // Callouts (GitHub-style admonitions)
    if (/^>\s*\[!\w+\]/.test(line)) {
      const callout = parseCallout(lines, i);
      if (callout) {
        blocks.push(callout.block);
        i += callout.linesConsumed;
        continue;
      }
    }

    // Toggles (HTML details)
    if (line.trim().startsWith('<details>')) {
      const toggle = parseToggle(lines, i);
      if (toggle) {
        blocks.push(toggle.block);
        i += toggle.linesConsumed;
        continue;
      }
    }

    // Code fence
    const codeStart = line.match(/^```(\w+)?\s*$/);
    if (codeStart) {
      const lang = codeStart[1] || "plain text";
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith("```")) i++;

      blocks.push({
        type: "code",
        code: { language: lang, rich_text: textToRichText(codeLines.join("\n")) },
      });
      continue;
    }

    // Divider
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push({ type: "divider", divider: {} });
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2] ?? "";
      const type = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
      blocks.push({
        type,
        [type]: { rich_text: parseInlineFormatting(text) },
      });
      i++;
      continue;
    }

    // Images
    const img = line.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (img) {
      const [, alt, url] = img;
      blocks.push({
        type: "image",
        image: {
          type: "external",
          external: { url },
          caption: parseInlineFormatting(alt)
        }
      });
      i++;
      continue;
    }

    // Lists (including nested and todos)
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+/);
    if (listMatch) {
      const result = parseNestedList(lines, i, 0);
      blocks.push(...result.items);
      i = result.endIndex;
      continue;
    }

    // Quote (simple blockquote, not callout)
    if (line.startsWith('>') && !/^>\s*\[!\w+\]/.test(line)) {
      const quote = line.replace(/^>\s?/, '');
      blocks.push({
        type: "quote",
        quote: { rich_text: parseInlineFormatting(quote) },
      });
      i++;
      continue;
    }

    // Paragraph: accumulate until blank line or block marker
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) break;
      if (l.trim().startsWith('|')) break;
      if (/^```/.test(l)) break;
      if (/^\s*---+\s*$/.test(l)) break;
      if (/^#{1,3}\s+/.test(l)) break;
      if (/^(\s*)([-*]|\d+\.)\s+/.test(l)) break;
      if (l.startsWith('>')) break;
      if (/^!\[.*?\]\(.*?\)$/.test(l)) break;
      if (l.trim().startsWith('<details>')) break;

      buf.push(l);
      i++;
    }

    if (buf.length > 0) {
      const text = buf.join("\n").trimEnd();
      if (text) {
        blocks.push({
          type: "paragraph",
          paragraph: { rich_text: parseInlineFormatting(text) },
        });
      }
    }
  }

  return blocks;
}

/** ---------- append children ---------- **/

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function appendBlocks(blockId, blocks) {
  const id = normaliseId(blockId);
  const chunks = chunk(blocks, MAX_BLOCKS_PER_APPEND);
  const results = [];

  for (const c of chunks) {
    const res = await notionRequest({
      method: "PATCH",
      path: `/v1/blocks/${id}/children`,
      body: { children: c },
    });
    results.push(res);
  }
  return results;
}

/** ---------- data sources and properties ---------- **/

async function getDataSource(dataSourceId) {
  const id = normaliseId(dataSourceId);
  return notionRequest({ method: "GET", path: `/v1/data_sources/${id}` });
}

function findTitlePropertyNameFromSchema(properties) {
  if (!isObject(properties)) return null;
  for (const [name, prop] of Object.entries(properties)) {
    if (isObject(prop) && prop.type === "title") return name;
  }
  return null;
}

function parseSetArgs(setArgs) {
  if (!setArgs) return [];
  const items = Array.isArray(setArgs) ? setArgs : [setArgs];
  return items.map((s) => {
    const idx = String(s).indexOf("=");
    if (idx === -1) throw new Error(`Invalid --set "${s}" (expected Prop=Value)`);
    const key = String(s).slice(0, idx).trim();
    const value = String(s).slice(idx + 1).trim();
    if (!key) throw new Error(`Invalid --set "${s}" (missing property name)`);
    return { key, value };
  });
}

function splitCommaList(s) {
  return String(s)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function coercePrimitive(s) {
  const t = String(s).trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.parse(t); } catch { /* fallthrough */ }
  }
  return t;
}

function buildPropertyValue({ schemaProp, rawValue }) {
  const type = schemaProp.type;
  const v = coercePrimitive(rawValue);

  if (["rollup", "formula", "created_by", "created_time", "last_edited_by", "last_edited_time"].includes(type)) {
    throw new Error(`Property type "${type}" cannot be set via the API`);
  }

  switch (type) {
    case "title":
      return { title: parseInlineFormatting(String(v ?? "")) };
    case "rich_text":
      return { rich_text: parseInlineFormatting(String(v ?? "")) };
    case "select":
      return { select: v ? { name: String(v) } : null };
    case "multi_select": {
      const names = Array.isArray(v) ? v.map(String) : splitCommaList(String(v ?? ""));
      return { multi_select: names.map((name) => ({ name })) };
    }
    case "status":
      return { status: v ? { name: String(v) } : null };
    case "date": {
      if (isObject(v)) return { date: v };
      return { date: v ? { start: String(v) } : null };
    }
    case "checkbox":
      return { checkbox: Boolean(v) };
    case "number":
      return { number: v === null ? null : Number(v) };
    case "url":
      return { url: v ? String(v) : null };
    case "email":
      return { email: v ? String(v) : null };
    case "phone_number":
      return { phone_number: v ? String(v) : null };
    case "people": {
      const ids = Array.isArray(v) ? v.map(String) : splitCommaList(String(v ?? ""));
      return { people: ids.map((id) => ({ id: normaliseId(id) })) };
    }
    case "relation": {
      const ids = Array.isArray(v) ? v.map(String) : splitCommaList(String(v ?? ""));
      return { relation: ids.map((id) => ({ id: normaliseId(id) })) };
    }
    default:
      throw new Error(`Unsupported property type "${type}" for --set`);
  }
}

function buildPropertiesFromSetArgs({ schema, setPairs }) {
  if (!schema || !isObject(schema.properties)) return {};
  const propsSchema = schema.properties;

  const out = {};
  for (const { key, value } of setPairs) {
    const schemaProp = propsSchema[key];
    if (!schemaProp) throw new Error(`Unknown property "${key}" on data source`);
    out[key] = buildPropertyValue({ schemaProp, rawValue: value });
  }
  return out;
}

/** ---------- commands ---------- **/

async function cmdWhoami({ compact }) {
  const me = await notionRequest({ method: "GET", path: "/v1/users/me" });
  print({ ok: true, user: me }, { compact });
}

async function cmdSearch({ compact, query, type = "all", limit = 20 }) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("search requires --query");

  const body = {
    query: q,
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: DEFAULT_PAGE_SIZE,
  };

  if (type !== "all") {
    if (type !== "page" && type !== "data_source") {
      throw new Error(`Invalid --type "${type}". Use page|data_source|all`);
    }
    body.filter = { property: "object", value: type };
  }

  const results = [];
  let cursor = undefined;

  while (results.length < limit) {
    if (cursor) body.start_cursor = cursor;

    const res = await notionRequest({ method: "POST", path: "/v1/search", body });
    if (res && Array.isArray(res.results)) results.push(...res.results);
    if (!res || !res.has_more) break;
    cursor = res.next_cursor;
    if (!cursor) break;
  }

  const trimmed = results.slice(0, limit).map((r) => {
    const base = {
      object: r.object,
      id: r.id,
      url: r.url,
      last_edited_time: r.last_edited_time,
    };
    if (r.object === "page") base.title = getPageTitle(r);
    if (r.object === "data_source") {
      const title = Array.isArray(r.title) ? r.title.map((t) => t.plain_text ?? "").join("") : null;
      base.title = title;
    }
    base.parent = r.parent;
    return base;
  });

  print({ ok: true, query: q, type, results: trimmed }, { compact });
}

async function cmdGetPage({ compact, page }) {
  const id = normaliseId(page);
  const p = await notionRequest({ method: "GET", path: `/v1/pages/${id}` });
  print({ ok: true, id, title: getPageTitle(p), page: p }, { compact });
}

async function cmdGetBlocks({ compact, page }) {
  const id = normaliseId(page);
  const blocks = await getBlockTree(id);
  print({ ok: true, page_id: id, blocks }, { compact });
}

async function cmdExportMd({ compact, page, stdoutMd = false }) {
  const id = normaliseId(page);
  const pageObj = await notionRequest({ method: "GET", path: `/v1/pages/${id}` });
  const title = getPageTitle(pageObj);
  const blocks = await getBlockTree(id);
  const markdown = blocksToMarkdown(blocks);

  if (stdoutMd) {
    process.stdout.write(markdown);
    return;
  }

  print({ ok: true, id, title, markdown }, { compact });
}

async function readMarkdownInput({ md, mdFile, mdStdin }) {
  if (md !== undefined) return String(md);
  if (mdFile !== undefined) {
    const p = resolveHome(String(mdFile));
    return fs.readFileSync(p, "utf8");
  }
  if (mdStdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Provide markdown via --md, --md-file, or --md-stdin");
}

function buildParent({ parentPage, parentDataSource }) {
  if (parentPage) {
    const page_id = normaliseId(parentPage);
    return { type: "page_id", page_id };
  }
  if (parentDataSource) {
    const data_source_id = normaliseId(parentDataSource);
    return { type: "data_source_id", data_source_id };
  }
  throw new Error("Provide either --parent-page or --parent-data-source");
}

function buildPosition({ position, afterBlock }) {
  if (afterBlock) return { type: "after_block", after_block: { id: normaliseId(afterBlock) } };
  if (!position) return null;
  if (position !== "page_start" && position !== "page_end") {
    throw new Error('Invalid --position. Use "page_start" or "page_end"');
  }
  return { type: position };
}

function buildTemplate({ template, templateId }) {
  if (templateId) return { type: "template_id", template_id: normaliseId(templateId) };
  if (!template) return null;
  if (!["none", "default"].includes(template)) {
    throw new Error('Invalid --template. Use "none" or "default" (or use --template-id)');
  }
  return { type: template };
}

async function cmdCreateMd({ compact, title, parentPage, parentDataSource, md, mdFile, mdStdin, set, template, templateId, position, afterBlock }) {
  const t = String(title ?? "").trim();
  if (!t) throw new Error("create-md requires --title");

  const parent = buildParent({ parentPage, parentDataSource });
  const templateObj = buildTemplate({ template, templateId });
  const positionObj = buildPosition({ position, afterBlock });

  let properties = {};

  if (parent.type === "page_id") {
    properties = { title: { title: parseInlineFormatting(t) } };
  } else {
    const schema = await getDataSource(parent.data_source_id);
    const titlePropName = findTitlePropertyNameFromSchema(schema.properties) ?? "Name";
    properties[titlePropName] = { title: parseInlineFormatting(t) };

    const setPairs = parseSetArgs(set);
    const extra = buildPropertiesFromSetArgs({ schema, setPairs });
    properties = { ...properties, ...extra };
  }

  const body = {
    parent,
    properties,
  };

  if (parent.type === "page_id" && positionObj) body.position = positionObj;

  if (templateObj) {
    body.template = templateObj;
  } else {
    const markdown = await readMarkdownInput({ md, mdFile, mdStdin });
    const blocks = parseMarkdownToBlocks(markdown);
    if (blocks.length) body.children = blocks;
  }

  const res = await notionRequest({ method: "POST", path: "/v1/pages", body });
  print({ ok: true, created: res }, { compact });
}

async function cmdAppendMd({ compact, page, md, mdFile, mdStdin }) {
  const id = normaliseId(page);
  const markdown = await readMarkdownInput({ md, mdFile, mdStdin });
  const blocks = parseMarkdownToBlocks(markdown);

  const responses = await appendBlocks(id, blocks);
  print({ ok: true, page_id: id, appended_blocks: blocks.length, responses }, { compact });
}

async function cmdUpdatePage({ compact, page, title, set }) {
  const id = normaliseId(page);
  
  // Fetch current page to determine parent type
  const currentPage = await notionRequest({ method: "GET", path: `/v1/pages/${id}` });
  const parent = currentPage.parent;
  
  const properties = {};
  
  // Update title if provided
  if (title !== undefined) {
    const t = String(title).trim();
    if (parent.type === "page_id" || parent.type === "workspace") {
      properties.title = { title: parseInlineFormatting(t) };
    } else if (parent.type === "data_source_id") {
      // Need to fetch schema to find title property name
      const schema = await getDataSource(parent.data_source_id);
      const titlePropName = findTitlePropertyNameFromSchema(schema.properties) ?? "Name";
      properties[titlePropName] = { title: parseInlineFormatting(t) };
    }
  }
  
  // Update other properties if provided
  if (set) {
    const setPairs = parseSetArgs(set);
    if (parent.type === "data_source_id") {
      const schema = await getDataSource(parent.data_source_id);
      const extra = buildPropertiesFromSetArgs({ schema, setPairs });
      Object.assign(properties, extra);
    } else {
      throw new Error("--set can only be used on pages in databases (data sources)");
    }
  }
  
  if (Object.keys(properties).length === 0) {
    throw new Error("update-page requires --title or --set");
  }
  
  const res = await notionRequest({
    method: "PATCH",
    path: `/v1/pages/${id}`,
    body: { properties }
  });
  
  print({ ok: true, updated: res }, { compact });
}

async function cmdUpdateBlock({ compact, block, md, mdFile, mdStdin }) {
  const id = normaliseId(block);
  const markdown = await readMarkdownInput({ md, mdFile, mdStdin });
  const blocks = parseMarkdownToBlocks(markdown);
  
  if (blocks.length === 0) {
    throw new Error("No blocks parsed from markdown");
  }
  
  if (blocks.length > 1) {
    throw new Error("update-block only supports single block updates. Use append-md for multiple blocks.");
  }
  
  const blockData = blocks[0];
  const type = blockData.type;
  
  const res = await notionRequest({
    method: "PATCH",
    path: `/v1/blocks/${id}`,
    body: {
      [type]: blockData[type]
    }
  });
  
  print({ ok: true, updated: res }, { compact });
}

async function cmdDeleteBlock({ compact, block }) {
  const id = normaliseId(block);
  
  const res = await notionRequest({
    method: "DELETE",
    path: `/v1/blocks/${id}`
  });
  
  print({ ok: true, deleted: true, block_id: id, result: res }, { compact });
}

async function cmdMove({ compact, page, toPage, toDataSource }) {
  const page_id = normaliseId(page);

  let parent = null;
  if (toPage) parent = { type: "page_id", page_id: normaliseId(toPage) };
  if (toDataSource) parent = { type: "data_source_id", data_source_id: normaliseId(toDataSource) };

  if (!parent) throw new Error("move requires --to-page or --to-data-source");

  const res = await notionRequest({
    method: "POST",
    path: `/v1/pages/${page_id}/move`,
    body: { parent },
  });

  print({ ok: true, moved_page_id: page_id, new_parent: parent, result: res }, { compact });
}

async function cmdListChildPages({ compact, page }) {
  const id = normaliseId(page);
  const blocks = await listBlockChildren(id);
  const childPages = blocks
    .filter((b) => b && b.type === "child_page")
    .map((b) => ({ id: b.id, title: b.child_page?.title ?? "Untitled" }));

  print({ ok: true, page_id: id, child_pages: childPages }, { compact });
}

function loadJsonFile(p) {
  const abs = resolveHome(String(p));
  const txt = fs.readFileSync(abs, "utf8");
  return JSON.parse(txt);
}

function ruleMatchesTitle(rule, title) {
  const m = rule.match;
  if (!m || !title) return false;
  if (m.title_regex) {
    const re = new RegExp(m.title_regex);
    return re.test(title);
  }
  if (m.contains) return title.toLowerCase().includes(String(m.contains).toLowerCase());
  return false;
}

async function cmdTriage({ compact, inboxPage, rules, limit = 50, apply = false }) {
  const inboxId = normaliseId(inboxPage);
  const rulesObj = loadJsonFile(rules);
  if (!Array.isArray(rulesObj)) throw new Error("rules JSON must be an array");

  const blocks = await listBlockChildren(inboxId);
  const childPages = blocks
    .filter((b) => b && b.type === "child_page")
    .map((b) => ({ id: b.id, title: b.child_page?.title ?? "Untitled" }))
    .slice(0, Number(limit));

  const plan = [];
  for (const p of childPages) {
    const rule = rulesObj.find((r) => ruleMatchesTitle(r, p.title));
    if (!rule) continue;

    const moveTo = rule.move_to;
    if (!moveTo || !moveTo.type || !moveTo.id) continue;

    plan.push({
      page_id: p.id,
      title: p.title,
      rule: rule.name ?? null,
      move_to: moveTo,
    });
  }

  if (!apply) {
    print({ ok: true, inbox_page: inboxId, apply: false, planned: plan }, { compact });
    return;
  }

  const results = [];
  for (const item of plan) {
    const parent =
      item.move_to.type === "page_id"
        ? { type: "page_id", page_id: normaliseId(item.move_to.id) }
        : item.move_to.type === "data_source_id"
          ? { type: "data_source_id", data_source_id: normaliseId(item.move_to.id) }
          : null;

    if (!parent) {
      results.push({ page_id: item.page_id, ok: false, error: `Unknown move_to.type: ${item.move_to.type}` });
      continue;
    }

    try {
      const res = await notionRequest({
        method: "POST",
        path: `/v1/pages/${normaliseId(item.page_id)}/move`,
        body: { parent },
      });
      results.push({ page_id: item.page_id, ok: true, moved_to: parent, result: res });
    } catch (e) {
      results.push({ page_id: item.page_id, ok: false, error: String(e) });
    }
  }

  print({ ok: true, inbox_page: inboxId, apply: true, moved: results }, { compact });
}

/** ---------- main ---------- **/

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) {
    usage();
    return;
  }

  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const compact = !!args.compact;

  try {
    switch (cmd) {
      case "whoami":
        await cmdWhoami({ compact });
        return;

      case "search":
        await cmdSearch({ compact, query: args.query, type: args.type ?? "all", limit: Number(args.limit ?? 20) });
        return;

      case "get-page":
        await cmdGetPage({ compact, page: args.page });
        return;

      case "get-blocks":
        await cmdGetBlocks({ compact, page: args.page });
        return;

      case "export-md":
        await cmdExportMd({ compact, page: args.page, stdoutMd: !!args["stdout-md"] });
        return;

      case "create-md":
        await cmdCreateMd({
          compact,
          title: args.title,
          parentPage: args["parent-page"],
          parentDataSource: args["parent-data-source"],
          md: args.md,
          mdFile: args["md-file"],
          mdStdin: !!args["md-stdin"],
          set: args.set,
          template: args.template,
          templateId: args["template-id"],
          position: args.position,
          afterBlock: args["after-block"],
        });
        return;

      case "append-md":
        await cmdAppendMd({
          compact,
          page: args.page,
          md: args.md,
          mdFile: args["md-file"],
          mdStdin: !!args["md-stdin"],
        });
        return;

      case "update-page":
        await cmdUpdatePage({
          compact,
          page: args.page,
          title: args.title,
          set: args.set,
        });
        return;

      case "update-block":
        await cmdUpdateBlock({
          compact,
          block: args.block,
          md: args.md,
          mdFile: args["md-file"],
          mdStdin: !!args["md-stdin"],
        });
        return;

      case "delete-block":
        await cmdDeleteBlock({
          compact,
          block: args.block,
        });
        return;

      case "move":
        await cmdMove({
          compact,
          page: args.page,
          toPage: args["to-page"],
          toDataSource: args["to-data-source"],
        });
        return;

      case "list-child-pages":
        await cmdListChildPages({ compact, page: args.page });
        return;

      case "triage":
        await cmdTriage({
          compact,
          inboxPage: args["inbox-page"],
          rules: args.rules,
          limit: Number(args.limit ?? 50),
          apply: !!args.apply,
        });
        return;

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    const s = String(e);
    let details = undefined;
    try {
      details = JSON.parse(s);
    } catch {
      details = s;
    }
    fail("Command failed", { details });
  }
}

await main();
