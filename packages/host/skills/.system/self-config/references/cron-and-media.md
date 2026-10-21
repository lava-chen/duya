# Cron, voice, and image generation

Three unrelated subsystems that share a "rarely-touched" feel — each
is configured once, then forgotten. Read only the section you need.

- Schedule a cron job
- Change voice input
- Enable image generation

---

## Schedule a cron job

Use `duya cron` / the Settings UI. Underlying source:
`~/.duya/cronjob.toml`.

```bash
duya cron list
duya cron add --name <id> --schedule "<cron-expr>" --task "<prompt>"
duya cron enable <id>
duya cron disable <id>
```

`cronjob.toml` is the single authoritative source for scheduled runs.
A restart is required after editing the file by hand.

---

## Change voice input

Use `duya_cli` (or the Settings UI if present). The CLI is the only
agent write path for `[voice]` config — do not hand-edit
`config.toml` for voice settings unless a `duya_cli` command cannot
express the change.

### First-use flow

1. **Diagnose** — read-only check of the local STT environment:
   ```json
   { "argv": ["voice", "doctor"], "format": "json" }
   ```
   Reports `binaryFound` (whisper.cpp binary), `binaryPath`,
   `model`, `modelReady`, `installSteps`, and `summary`. If
   `modelReady` and `binaryFound` are both true, voice is ready —
   stop here.
2. **Download the model** — if `modelReady` is false, fetch and
   verify the configured model:
   ```json
   { "argv": ["voice", "setup"], "yes": true, "format": "json" }
   ```
3. **Provide the whisper.cpp binary** — if `binaryFound` is false,
   the native binary cannot be fully provisioned automatically.
   Follow the `installSteps` from `doctor`:
   - **Windows**: download the official whisper.cpp release zip,
     extract `whisper-cli`, and place it on `PATH` (or tell the user
     where DUYA looks for it). Then re-run `duya voice doctor`.
   - **macOS**: `brew install whisper-cpp`, then re-run `duya voice
     doctor`.
   - **Linux**: build whisper.cpp from source (cmake + make), then
     re-run `duya voice doctor`.

   Do not claim the binary is installed until `doctor` reports
   `binaryFound: true`.
4. **Write the config** — write operations need `yes: true`:
   ```json
   { "argv": ["voice", "enable"], "yes": true, "format": "json" }
   ```
   For **local whisper.cpp**, also set the engine and model:
   ```json
   { "argv": ["voice", "set", "stt.engine", "local"], "yes": true, "format": "json" }
   { "argv": ["voice", "set", "stt.local.model", "<model-file>"], "yes": true, "format": "json" }
   ```
   For **cloud (OpenAI-compatible)**, switch the engine — the
   provider's `baseUrl` and `apiKey` are reused:
   ```json
   { "argv": ["voice", "set", "stt.engine", "cloud"], "yes": true, "format": "json" }
   ```
   If no usable provider is configured, ask the user to add one
   before completing cloud setup. Never put an API key in
   `config.toml`; cloud mode reads secrets from the provider config,
   not from voice settings.
5. **Verify** — re-run the diagnostic and confirm the write took
   effect:
   ```json
   { "argv": ["voice", "doctor"], "format": "json" }
   ```
   Report the final `engines`/`model` state and `voice.enabled =
   true`.

### Failure modes

- `doctor` reports **app-unavailable** — DUYA's CLI API is not
  reachable. Ask the user to open DUYA and retry.
- `voice set` path is rejected — re-read `doctor`'s fields and retry
  with the exact field name (`stt.engine`, `stt.local.model`, etc.).

---

## Enable image generation

Add a `[image_generation]` section to `config.toml` (no dedicated
CLI subcommand exists; this one is a file edit):

```toml
[image_generation]
enabled = true
provider = "openai"     # openai | fal
model = "gpt-image-1"   # openai: gpt-image-1/2, dall-e-3; fal: fal-ai/flux/dev …
# base_url = ""         # OpenAI-compatible endpoint override (optional)
size = "1024x1024"
quality = "auto"        # auto | low | medium | high
# output_dir = ""       # default ~/.duya/media/generated
# timeout_ms = 180000
```

Store the key in env (`IMAGE_GENERATION_API_KEY`, or `OPENAI_API_KEY`
for the openai provider / `FAL_KEY` for fal) — prefer env over the
`api_key` field per the secrets rule above. The `image_generate` tool
stays off the default tool surface (exposeMode `discoverable`): the
agent reaches it via `tool_search`, or the user can generate
directly:

```bash
duya image "<prompt>" [--provider …] [--model …] [--size …]
duya image:config    # inspect the effective config
```