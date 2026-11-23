# dsh-local-persona-switch

[![English](https://img.shields.io/badge/README-English-blue)](./README.md)
[![简体中文](https://img.shields.io/badge/README-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](./README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that swaps the deployment **persona** to a different markdown file depending on whether the active model is served by a **local** provider or a **cloud** one.

Useful when a small local model needs a terser, faster persona while a cloud model keeps the full one.

## How it decides

The plugin classifies each route as `local` or `cloud` using, in order:

1. **Provider id** — matched against `localPatterns` (substring, case-insensitive) and `localProviders` (exact). Defaults cover `ollama`, `llama-cpp`, `lmstudio`, `vllm`, `koboldcpp`, `local`, and similar.
2. **baseURL host** — read from the harness settings service when available, or supplied via the `baseURL` option. Loopback and private IPv4 ranges (`127.*`, `10.*`, `192.168.*`, `172.16–31.*`) count as local.

Nothing is hard-coded to a particular machine: persona files default to `$DSH_HOME` (or `~/.dsh`).

## Install

```bash
dsh plugin --profile <your-profile> add dsh-local-persona-switch
```

Or add it manually to your profile's `package.json`:

```json
{
  "dependencies": { "dsh-local-persona-switch": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-local-persona-switch"] } }
}
```

Then create the two persona files (defaults shown):

- `$DSH_HOME/AGENTS-local.md` — used for local routes
- `$DSH_HOME/AGENTS-cloud.md` — used otherwise

A missing file is not an error; the section simply stays empty.

## Configure

Override any default in your profile's `cordis.patch.yml`:

```yaml
- id: local-persona-switch
  name: dsh-local-persona-switch
  config:
    localProviders:
      - my-local-box
    localPatterns:
      - ollama
      - llama-cpp
    localHosts:
      - localhost
      - 127.0.0.1
    localPersonaFile: /opt/personas/AGENTS-local.md
    cloudPersonaFile: /opt/personas/AGENTS-cloud.md
    watchFiles: true
    log: true
```

| Option | Default | Meaning |
|---|---|---|
| `localProviders` | `[]` | Provider ids treated as local even if no pattern matches |
| `localPatterns` | built-in list | Substrings matched against the provider route id |
| `localHosts` | `localhost`, `127.0.0.1`, `::1`, … | Hostnames that force the local classification |
| `baseURL` | unset | Fixed endpoint to classify when settings lookup is unavailable |
| `localPersonaFile` | `$DSH_HOME/AGENTS-local.md` | Persona used for local routes |
| `cloudPersonaFile` | `$DSH_HOME/AGENTS-cloud.md` | Persona used otherwise; empty string disables the override |
| `watchFiles` | `true` | Re-read persona files when their mtime changes |
| `log` | `true` | Log one info line per classification change |

## How it applies the persona

On `agent/pre-step` the plugin registers a section named `deployment:persona` (order `0`) in the **agent's own scope**, which shadows the deployment persona for that agent only. If the revision does not expose a per-agent `systemPrompt` service, it falls back to a runtime-context contribution.

Unchanged personas are not re-registered: the plugin tracks a digest per agent.

## Verify

```bash
node test/smoke.mjs   # pure helpers + a fake Cordis context
node test/entry.mjs   # module entry shape
```

## Limitations

- Local detection is heuristic. A route with an unfamiliar provider id and no readable baseURL will be treated as cloud; add it to `localProviders`.
- Persona text is applied only when the file is non-empty. An empty `cloudPersonaFile` therefore leaves the deployment persona untouched.
- The baseURL lookup is best-effort; harness revisions that do not expose provider settings still work through provider-id rules.

## License

MIT
