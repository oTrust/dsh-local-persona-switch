/**
 * dsh-local-persona-switch
 *
 * Swaps the DeepSeek Harness `deployment:persona` system-prompt section to a
 * different markdown file when the active model is served by a local provider.
 *
 * Why the assemble waterfall and not `agent/pre-step`:
 * `dsh-agent-loop` calls `systemPrompt.assemble()` BEFORE dispatching
 * `agent/pre-step`. A persona registered inside the pre-step hook therefore
 * lands one step too late — the turn that triggers the switch still renders the
 * old persona. Hooking `system-prompt/assemble` edits the assembly that is
 * about to be rendered, so the switch takes effect in the same step.
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
 *   replacePersonaSection(assembly, text)   -> boolean
 *   providerOfAgent(agent)      -> string | undefined
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** Section name the harness uses for the deployment persona (order 0). */
export const PERSONA_SECTION = "deployment:persona";

/** Prompt order of the persona slot. */
export const PERSONA_ORDER = 0;

/** Waterfall that owns the authoritative prompt assembly. */
export const ASSEMBLE_EVENT = "system-prompt/assemble";

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
    /** Fixed endpoint used for classification when no provider id matches. */
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

/**
 * Read the provider route off an agent.
 *
 * `agent.options.provider` is what `dsh-agent-loop` itself uses to build the
 * request route (see `buildRequest`), so it is the authoritative value. The
 * remaining candidates only cover older/alternate revisions.
 */
export function providerOfAgent(agent) {
  if (!agent) return undefined;
  const candidates = [
    agent.options?.provider,
    agent.provider,
    agent.modelSelection?.provider,
    agent.selection?.provider,
    agent.session?.header?.provider,
  ];
  return candidates.find((v) => typeof v === "string" && v.length > 0);
}

/** Read the model id off an agent, for logging only. */
function modelOfAgent(agent) {
  if (!agent) return undefined;
  const candidates = [
    agent.options?.model,
    agent.model,
    agent.modelSelection?.model,
    agent.selection?.model,
    agent.session?.header?.model,
  ];
  return candidates.find((v) => typeof v === "string" && v.length > 0);
}

/**
 * Replace (or insert) the deployment persona section in an assembly.
 *
 * The assembly is mutated in place and the same object is returned, because the
 * waterfall's return value is authoritative and callers may have captured the
 * original reference. Existing section metadata (name/order) is preserved; only
 * `text` changes.
 *
 * @param {{sections: Array<{name: string, text: string}>}} assembly
 * @param {string} text  Persona markdown. Empty text leaves the assembly alone.
 * @returns {"replaced"|"inserted"|"unchanged"}
 */
export function replacePersonaSection(assembly, text) {
  if (!assembly || !Array.isArray(assembly.sections)) return "unchanged";
  if (typeof text !== "string" || text.length === 0) return "unchanged";

  for (const section of assembly.sections) {
    if (section && section.name === PERSONA_SECTION) {
      if (section.text === text) return "unchanged";
      section.text = text;
      return "replaced";
    }
  }

  // No persona slot in this scope: contribute one at the persona position.
  assembly.sections.unshift({ name: PERSONA_SECTION, text });
  return "inserted";
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);

  /** path -> { text, mtimeMs, size } */
  const fileCache = new Map();
  /** agent -> last classification, for change-only logging. */
  const lastKind = new WeakMap();

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

  ctx.effect(
    () => () => {
      fileCache.clear();
    },
    "local-persona-switch.cache",
  );

  ctx.on(ASSEMBLE_EVENT, async (assembly, assembleContext, next) => {
    // Run the rest of the chain first so later listeners see the persona we
    // install, and so we never clobber a section they add.
    const result = await next();
    const target = result ?? assembly;

    try {
      const agent = assembleContext?.agent ?? assembleContext?.scope;
      const provider = providerOfAgent(agent);
      const model = modelOfAgent(agent);
      const kind = personaKind(provider, cfg.baseURL, cfg);
      const path = kind === "local" ? cfg.localPersonaFile : cfg.cloudPersonaFile;
      const text = path ? readCached(path) : "";
      const outcome = replacePersonaSection(target, text);

      if (cfg.log && agent && lastKind.get(agent) !== kind) {
        lastKind.set(agent, kind);
        ctx.logger?.info?.(
          "local-persona-switch: provider=%s model=%s -> %s persona (%s, %d chars)",
          provider ?? "(unknown)",
          model ?? "(unknown)",
          kind,
          outcome,
          text.length,
        );
      }
    } catch (error) {
      // A persona swap must never break prompt assembly.
      ctx.logger?.warn?.("local-persona-switch: skipped (%s)", String(error));
    }

    return target;
  });
}

export default apply;
