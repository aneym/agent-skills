# agent-skills

A curated collection of agent skills for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenClaw](https://openclaw.ai), [Codex](https://github.com/openai/codex), and other AI coding agents.

## Skills

| Skill | Description |
|-------|-------------|
| [todoist-api](skills/todoist-api/) | Manage Todoist tasks, projects, sections, labels, and comments via the REST API v2. |
| [plaid](skills/plaid/) | Query bank balances, transactions, and spending insights via Plaid API. |

## Install

### Via [skills.sh](https://skills.sh)

```bash
npx skills add aneym/agent-skills --skill todoist-api
npx skills add aneym/agent-skills --skill plaid
```

### Via [ClawHub](https://clawhub.com)

```bash
clawhub install todoist-api
```

### Manual

Copy the skill folder into your agent's skills directory.

## Contributing

PRs welcome. Each skill lives in `skills/<name>/` with a `SKILL.md` and optional `references/`, `scripts/`, `assets/` dirs.

## License

MIT
