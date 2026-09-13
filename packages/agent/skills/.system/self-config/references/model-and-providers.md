# Model providers

Add or switch model providers used by DUYA. The CLI is the only agent
write path for this section — do not hand-edit `config.toml` for
provider changes unless the CLI cannot express them.

## CLI path (preferred)

Use the Settings UI or `duya provider`:

```bash
duya provider add
duya provider list
duya provider use <id>
```

The CLI validates the entry, splits the API key into `secrets.json`,
and triggers the provider hot-reload IPC.

## Underlying `config.toml` shape

If a CLI command is unavailable, the file edit looks like:

```toml
[model]
default = "<model-id>"
provider = "<provider-id>"
base_url = "<endpoint-url>"      # optional, only if provider has no default

[providers.<id>]
providerType = "anthropic" | "openai"
baseUrl = "<endpoint>"
# options = { ... }              # provider-specific
```

The API key is **not** stored in `config.toml`. Add it to
`secrets.json` under a stable key and reference the provider id.

## Validation checklist

After any change:

1. Re-read the file and confirm `providerType` matches the `baseUrl`
   protocol (`anthropic` for Anthropic-format endpoints, `openai` for
   OpenAI-format).
2. Run `duya provider list` and confirm the new entry shows up.
3. Trigger one chat turn to confirm the model actually responds —
   parsing the TOML does not prove the endpoint is reachable.