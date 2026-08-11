---
name: voice-setup
description: Configure DUYA voice input (whisper.cpp local STT or OpenAI-compatible cloud STT) through the `duya_cli` control plane. Use when the user tries to use the voice button and whisper is not ready, when voice input returns "model not ready" / "environment not ready", or when the user asks to set up / install / configure voice input or whisper (e.g. '配一下语音', '安装 whisper', '语音输入用不了'). Diagnoses the local whisper environment, downloads the configured model, writes the `[voice]` config, and verifies readiness.
when-to-use: Whenever DUYA voice input needs first-use configuration or a whisper environment / STT engine is missing or misconfigured.
---

# Voice Setup

Configure DUYA voice input through `duya_cli`. The control plane is the only
agent write path for `[voice]` config — do not hand-edit `config.toml` for
voice settings unless a `duya_cli` command cannot express the change.

## Tool access

`duya_cli` is discoverable. If it is not in the current tool list, call
`tool_search` with `duya_cli`, then use the complete schema supplied on the
next turn. Do not substitute a shell command or a direct file write.

## Diagnose the environment

1. Run the read-only diagnostic first:

```json
{ "argv": ["voice", "doctor"], "format": "json" }
```

It reports `binaryFound` (whisper.cpp binary), `binaryPath`, `model`,
`modelReady`, `installSteps`, and `summary`. Decide the path from it:

- `modelReady === true` and `binaryFound === true` → voice is ready. Report
  readiness and stop (see "Verification").
- `modelReady === false` → the configured model is not downloaded.
- `binaryFound === false` → the whisper.cpp binary is missing.

## Download the configured model

2. If the model is missing, download + verify it:

```json
{ "argv": ["voice", "setup"], "yes": true, "format": "json" }
```

This fetches the configured model (e.g. `ggml-base.bin`) to the model cache the
`doctor` reported. If it fails, report the download source and ask the user
before retrying.

## Provide the whisper.cpp binary

3. If `binaryFound === false`, the native whisper.cpp binary is missing, which
   cannot be provisioned fully automatically. Follow the platform step from
   `doctor`'s `installSteps` and guide the user:

- **Windows**: download the official whisper.cpp release zip, extract the
  `whisper-cli` executable, and place it on `PATH` (or tell the user where DUYA
  looks for it). Then re-run `duya voice doctor`.
- **macOS**: `brew install whisper-cpp`, then re-run `duya voice doctor`.
- **Linux**: build whisper.cpp from source (cmake + make), then re-run
  `duya voice doctor`.

Do not claim the binary is installed until `doctor` reports `binaryFound: true`.

## Write the config

4. Enable voice and set the STT engine. Write operations need `yes: true`:

```json
{ "argv": ["voice", "enable"], "yes": true, "format": "json" }
```

- **Local whisper.cpp**:

```json
{ "argv": ["voice", "set", "stt.engine", "local"], "yes": true, "format": "json" }
{ "argv": ["voice", "set", "stt.local.model", "<model-file>"], "yes": true, "format": "json" }
```

Use the model file name confirmed by `voice setup` (e.g. `ggml-base.bin`).

- **Cloud (OpenAI-compatible)**:

```json
{ "argv": ["voice", "set", "stt.engine", "cloud"], "yes": true, "format": "json" }
```

Cloud mode reuses the configured provider's `baseUrl` and `apiKey`. If no
usable provider is configured, tell the user to add one (or ask them to
provide `baseUrl` / `apiKey`) before completing.

## Verification

5. Re-run the diagnostic and confirm the write took effect:

```json
{ "argv": ["voice", "doctor"], "format": "json" }
```

Report to the user with the final `engines`/`model` state and keyword
`voice.enabled = true`. If `doctor` still shows a missing binary, provide the
platform install step and ask the user to complete it, then re-check.

## Failure handling

- If `voice doctor` reports an app-unavailable error, DUYA's CLI API is not
  reachable — ask the user to open DUYA and retry.
- If a `voice set` path is rejected, re-read `doctor`'s fields and retry with
  the exact field name (e.g. `stt.engine`, `stt.local.model`).
- Never put an API key in `config.toml`; cloud mode reads secrets from the
  provider config, not from voice settings.