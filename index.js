/**
 * dsh-local-persona-switch
 *
 * Swaps the DeepSeek Harness `deployment:persona` system-prompt section to a
 * different markdown file when the active model is served by a local provider.
 *
 * The plugin is environment-agnostic: it ships sensible defaults, resolves the
 * persona directory from $DSH_HOME (falling back to ~/.dsh), and lets every
 * rule be overridden through plugin config.
 *
 * Public surface (also used by the smoke test):
 *   apply(ctx, config)          Cordis plugin entry point
 *   resolveConfig(config)       Normalised configuration
 *   isLocalRoute({provider,baseURL}, config)
 *   personaKind(provider, baseURL, config) -> "local" | "cloud"
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** Section name the harness uses for the deployment persona (order 0). */
export const PERSONA_SECTION = "deployment:persona";

/**
 * Provider-id fragments that usually mean "an endpoint on this machine".
 * Matched case-insensitively as substrings of the provider route id.
 */
export const DEFAULT_LOCAL_PATTERNS = [
  "ollama",
  "llama-cpp",
  "llamacpp",
  "llama.cpp",
  "lmstudio",
  "lm-studio",
  "local",
  "localhost",
  "vllm",
  "koboldcpp",
  "text-generation-webui",
  "oobabooga",
];

/** baseURL hostnames that can only be local. */
export const DEFAULT_LOCAL_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
];

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), ".dsh");
}

/**
 * Normalise user configuration into the shape the plugin actually uses.
 * Every option is optional; nothing here assumes a particular machine.
 */
export function resolveConfig(config) {
  const c = config ?? {};
  const home = dshHome();

  const localPatterns =
    Array.isArray(c.localPatterns) && c.localPatterns.length > 0
      ? c.localPatterns.map(String)
      : DEFAULT_LOCAL_PATTERNS;

  const localHosts =
    Array.isArray(c.localHosts) && c.localHosts.length > 0
      ? c.localHosts.map(String)
      : DEFAULT_LOCAL_HOSTS;

  return {
    /** Extra provider ids treated as local even if no pattern matches. */
    localProviders: Array.isArray(c.localProviders)
      ? c.localProviders.map(String)
      : [],
    /** Substrings matched against the provider route id. */
    localPatterns,
    /** Hostnames that force the local classification. */
    localHosts,
    /** Optional baseURL override source; disabled unless configured. */
    baseURL: typeof c.baseURL === "string" ? c.baseURL : undefined,
    /** Markdown file used when the route is local. */
    localPersonaFile: resolvePath(
      c.localPersonaFile ?? join(home, "AGENTS-local.md"),
    ),
    /** Markdown file used otherwise. Empty string disables the override. */
    cloudPersonaFile: resolvePath(
      c.cloudPersonaFile ?? join(home, "AGENTS-cloud.md"),
    ),
    /** Re-read persona files when their mtime changes. */
    watchFiles: c.watchFiles !== false,
    /** Emit one info log line per classification change. */
    log: c.log !== false,
  };
}

function hostOf(baseURL) {
  if (typeof baseURL !== "string" || baseURL.length === 0) return undefined;
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    // Tolerate scheme-less values such as "127.0.0.1:8080/v1".
    const match = /^[a-z]+:\/\/([^/:]+)/i.exec(baseURL);
    return match ? match[1].toLowerCase() : undefined;
  }
}

/** True when the provider id contains one of the configured local patterns. */
export function isLocalProvider(provider, config) {
  if (typeof provider !== "string" || provider.length === 0) return false;
  const id = provider.toLowerCase();
  if (config.localProviders.some((p) => p.toLowerCase() === id)) return true;
  return config.localPatterns.some((p) => id.includes(p.toLowerCase()));
}

/**
 * Decide whether one route is local.
 * @param {{provider?: string, baseURL?: string}} route
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {boolean}
 */
export function isLocalRoute(route, config) {
  if (isLocalProvider(route?.provider, config)) return true;
  const host = hostOf(route?.baseURL ?? config.baseURL);
  if (host === undefined) return false;
  if (config.localHosts.some((h) => h.toLowerCase() === host)) return true;
  // Private IPv4 ranges and loopback count as local too.
  if (/^127\./.test(host) || /^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** Convenience wrapper returning "local" or "cloud". */
export function personaKind(provider, baseURL, config) {
  return isLocalRoute({ provider, baseURL }, config) ? "local" : "cloud";
}

/** Read a persona file, returning "" when it is missing or unreadable. */
export function readPersonaFile(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Pull the provider id off an agent across harness revisions. */
function providerOf(agent) {
  if (!agent) return undefined;
  const candidates = [
    agent.provider,
    agent.modelSelection?.provider,
    agent.selection?.provider,
    agent.session?.header?.provider,
    agent.session?.provider,
    agent.session?.modelSelection?.provider,
  ];
  return candidates.find((v) => typeof v === "string" && v.length > 0);
}

function modelOf(agent) {
  if (!agent) return undefined;
  const candidates = [
    agent.model,
    agent.modelSelection?.model,
    agent.selection?.model,
    agent.session?.header?.model,
    agent.session?.model,
  ];
  return candidates.find((v) => typeof v === "string" && v.length > 0);
}

/**
 * Resolve a route's baseURL from the harness settings service when it is
 * readable. This is strictly best-effort: any failure yields undefined and the
 * provider-id rules still apply.
 */
function baseURLFromSettings(ctx, provider, config) {
  if (config.baseURL) return config.baseURL;
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  let settings;
  try {
    settings = ctx.get("settings");
  } catch {
    return undefined;
  }
  if (!settings || typeof settings.get !== "function") return undefined;

  const namespaces = [
    "llm",
    "@deepseek-ai/dsh-llm-pi-ai",
    "@deepseek-ai/dsh-llm-ollama",
    "llm-pi-ai",
  ];
  for (const ns of namespaces) {
    let value;
    try {
      value = settings.get(ns);
    } catch {
      continue;
    }
    const found = findBaseURL(value, provider, 0);
    if (found) return found;
  }
  return undefined;
}

/** Depth-limited search for `<provider>.baseURL` inside a settings value. */
function findBaseURL(value, provider, depth) {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;
  const providers = value.providers ?? value;
  if (providers && typeof providers === "object") {
    const entry = providers[provider];
    if (entry && typeof entry === "object") {
      const candidate = entry.baseURL ?? entry.baseUrl ?? entry.url;
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
  }
  for (const child of Object.values(providers)) {
    if (child && typeof child === "object") {
      const hit = findBaseURL(child, provider, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);

  /** Per-agent registration state: agent -> { disposer, kind, digest }. */
  const applied = new WeakMap();
  /** path -> { text, mtimeMs, size } */
  const fileCache = new Map();

  const readCached = (path) => {
    if (!path) return "";
    if (!cfg.watchFiles) {
      if (!fileCache.has(path)) {
        fileCache.set(path, { text: readPersonaFile(path), mtimeMs: 0, size: -1 });
      }
      return fileCache.get(path).text;
    }
    let mtimeMs = -1;
    let size = -1;
    try {
      const st = statSync(path);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      // Missing file: fall through and read (which returns "").
    }
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.text;
    }
    const text = readPersonaFile(path);
    fileCache.set(path, { text, mtimeMs, size });
    return text;
  };

  const disposeApplied = (agent) => {
    const entry = applied.get(agent);
    if (!entry) return;
    applied.delete(agent);
    try {
      entry.disposer?.();
    } catch {
      // A partially constructed scope may already be torn down.
    }
  };

  ctx.effect(
    () => () => {
      fileCache.clear();
    },
    "local-persona-switch.cache",
  );

  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();

    try {
      const provider = providerOf(agent);
      const model = modelOf(agent);
      const baseURL = baseURLFromSettings(ctx, provider, cfg);
      const kind = personaKind(provider, baseURL, cfg);
      const path = kind === "local" ? cfg.localPersonaFile : cfg.cloudPersonaFile;
      const text = path ? readCached(path) : "";
      const digest = `${kind}:${path}:${text.length}`;

      const previous = applied.get(agent);
      if (previous && previous.digest === digest) return decision;

      // Project-local scope first: it shadows the deployment persona for this
      // agent only. Fall back to a runtime-context contribution when the
      // revision does not expose a per-agent systemPrompt service.
      let disposer;
      let via = "none";
      try {
        const scoped = agent?.ctx?.get?.("systemPrompt");
        if (scoped && typeof scoped.section === "function" && text.length > 0) {
          disposer = scoped.section({
            name: PERSONA_SECTION,
            order: 0,
            text,
          });
          via = "agent-section";
        }
      } catch {
        disposer = undefined;
      }

      if (via === "none" && text.length > 0) {
        try {
          const sp = ctx.get("systemPrompt");
          if (sp && typeof sp.context === "function") {
            disposer = sp.context({
              name: "local-persona-switch:persona",
              order: -1,
              text,
            });
            via = "global-context";
          }
        } catch {
          disposer = undefined;
        }
      }

      disposeApplied(agent);
      if (disposer) applied.set(agent, { disposer, digest, kind });

      if (cfg.log && (!previous || previous.kind !== kind)) {
        ctx.logger?.info?.(
          "local-persona-switch: provider=%s model=%s baseURL=%s -> %s persona via %s (%d chars)",
          provider ?? "(unknown)",
          model ?? "(unknown)",
          baseURL ?? "(unknown)",
          kind,
          via,
          text.length,
        );
      }
    } catch (error) {
      // A persona swap must never break the turn.
      ctx.logger?.warn?.("local-persona-switch: skipped (%s)", String(error));
    }

    return decision;
  });
}

export default apply;
