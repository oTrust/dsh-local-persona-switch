/**
 * Smoke tests for dsh-local-persona-switch.
 * Run with: node test/smoke.mjs
 *
 * The load-bearing test is "assembly is rewritten in the same step": the old
 * implementation hooked `agent/pre-step`, which the agent loop dispatches AFTER
 * `systemPrompt.assemble()`, so the persona only landed one step late. A fake
 * context that replicates that ordering catches the regression.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  apply,
  resolveConfig,
  isLocalProvider,
  isLocalRoute,
  personaKind,
  readPersonaFile,
  replacePersonaSection,
  providerOfAgent,
  PERSONA_SECTION,
  ASSEMBLE_EVENT,
} from "../index.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

/** Minimal Cordis-like context driving the assemble waterfall. */
function fakeContext() {
  const listeners = new Map();
  const logs = [];
  const systemPrompt = { section: () => () => {}, context: () => () => {} };
  const ctx = {
    get: (name) => (name === "systemPrompt" ? systemPrompt : undefined),
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    on: (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    logger: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
    },
  };
  return { ctx, listeners, logs, systemPrompt };
}

/**
 * Run one prompt assembly the way `dsh-agent-loop` does: build the seed
 * assembly, run the waterfall, and return what the model would receive.
 */
async function assemble(handle, { provider, model = "m", seedText = "DEPLOYMENT PERSONA" } = {}) {
  const listener = handle.listeners.get(ASSEMBLE_EVENT);
  const seed = {
    sections: [
      { name: "harness:identity", text: "IDENTITY" },
      { name: PERSONA_SECTION, text: seedText },
      { name: "tools:guidance", text: "TOOLS" },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
  const assembleContext = { agent: { options: { provider, model } }, scope: {} };
  const next = async () => seed;
  if (!listener) return seed;
  return listener(seed, assembleContext, next);
}

const agent = (provider, model = "m") => ({ options: { provider, model } });

/** Create a temp dir holding a local + cloud persona. */
async function withPersonas(fn) {
  const dir = mkdtempSync(join(tmpdir(), "persona-"));
  try {
    const local = join(dir, "local.md");
    const cloud = join(dir, "cloud.md");
    writeFileSync(local, "LOCAL PERSONA", "utf8");
    writeFileSync(cloud, "CLOUD PERSONA", "utf8");
    return await fn({ dir, local, cloud });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("defaults are environment-agnostic", () => {
  const cfg = resolveConfig({});
  assert.ok(cfg.localPersonaFile.endsWith("AGENTS-local.md"));
  assert.ok(cfg.cloudPersonaFile.endsWith("AGENTS-cloud.md"));
  assert.ok(cfg.localPatterns.includes("ollama"));
  assert.ok(cfg.localHosts.includes("127.0.0.1"));
  const expectedRoot = process.env.DSH_HOME
    ? process.env.DSH_HOME.trim()
    : join(homedir(), ".dsh");
  assert.equal(cfg.localPersonaFile, join(expectedRoot, "AGENTS-local.md"));
});

await test("config overrides win", () => {
  const cfg = resolveConfig({
    localProviders: ["my-box"],
    localPatterns: ["custom"],
    localPersonaFile: "/tmp/a.md",
    cloudPersonaFile: "/tmp/b.md",
  });
  assert.deepEqual(cfg.localProviders, ["my-box"]);
  assert.deepEqual(cfg.localPatterns, ["custom"]);
  assert.ok(cfg.localPersonaFile.includes("a.md"));
});

await test("provider id detection", () => {
  const cfg = resolveConfig({});
  assert.equal(isLocalProvider("ollama", cfg), true);
  assert.equal(isLocalProvider("llama-cpp-qwen-3-4b", cfg), true);
  assert.equal(isLocalProvider("openai", cfg), false);
  assert.equal(isLocalProvider(undefined, cfg), false);
});

await test("baseURL host detection", () => {
  const cfg = resolveConfig({});
  assert.equal(isLocalRoute({ provider: "x", baseURL: "http://localhost:11434/v1" }, cfg), true);
  assert.equal(isLocalRoute({ provider: "x", baseURL: "http://127.0.0.1:8080/v1" }, cfg), true);
  assert.equal(isLocalRoute({ provider: "x", baseURL: "http://192.168.1.9:1234/v1" }, cfg), true);
  assert.equal(isLocalRoute({ provider: "x", baseURL: "http://172.16.4.2/v1" }, cfg), true);
  assert.equal(isLocalRoute({ provider: "x", baseURL: "https://api.openai.com/v1" }, cfg), false);
});

await test("personaKind wrapper", () => {
  const cfg = resolveConfig({});
  assert.equal(personaKind("ollama", undefined, cfg), "local");
  assert.equal(personaKind("openai", "https://api.x.com/v1", cfg), "cloud");
});

await test("readPersonaFile tolerates a missing path", () => {
  assert.equal(readPersonaFile(""), "");
  assert.equal(readPersonaFile("Z:\\definitely\\missing.md"), "");
});

await test("providerOfAgent prefers the agent-loop authoritative route", () => {
  assert.equal(providerOfAgent({ options: { provider: "ollama" }, provider: "stale" }), "ollama");
  assert.equal(providerOfAgent({ provider: "ollama" }), "ollama");
  assert.equal(providerOfAgent(undefined), undefined);
});

await test("replacePersonaSection replaces text in place", () => {
  const assembly = { sections: [{ name: PERSONA_SECTION, text: "old" }] };
  assert.equal(replacePersonaSection(assembly, "new"), "replaced");
  assert.equal(assembly.sections[0].text, "new");
  assert.equal(replacePersonaSection(assembly, "new"), "unchanged");
  assert.equal(replacePersonaSection(assembly, ""), "unchanged", "empty never clears");
});

await test("replacePersonaSection inserts when the slot is absent", () => {
  const assembly = { sections: [{ name: "tools:guidance", text: "T" }] };
  assert.equal(replacePersonaSection(assembly, "PERSONA"), "inserted");
  assert.equal(assembly.sections[0].name, PERSONA_SECTION);
  assert.equal(assembly.sections[1].name, "tools:guidance");
});

await test("assembly is rewritten in the SAME step for a local route", () =>
  withPersonas(async ({ local, cloud }) => {
    const handle = fakeContext();
    apply(handle.ctx, { localPersonaFile: local, cloudPersonaFile: cloud, log: false });

    const out = await assemble(handle, { provider: "ollama" });
    const persona = out.sections.find((s) => s.name === PERSONA_SECTION);
    assert.equal(persona.text, "LOCAL PERSONA");
    // The surrounding sections must survive the swap untouched.
    assert.deepEqual(
      out.sections.map((s) => s.name),
      ["harness:identity", PERSONA_SECTION, "tools:guidance"],
    );
    assert.equal(handle.listeners.has(ASSEMBLE_EVENT), true, "listener was registered");
  }));

await test("cloud routes get the cloud persona in the same step", () =>
  withPersonas(async ({ local, cloud }) => {
    const handle = fakeContext();
    apply(handle.ctx, { localPersonaFile: local, cloudPersonaFile: cloud, log: false });
    const out = await assemble(handle, { provider: "openai" });
    assert.equal(
      out.sections.find((s) => s.name === PERSONA_SECTION).text,
      "CLOUD PERSONA",
    );
  }));

await test("empty cloudPersonaFile leaves the deployment persona intact", () =>
  withPersonas(async ({ local }) => {
    const handle = fakeContext();
    apply(handle.ctx, { localPersonaFile: local, cloudPersonaFile: "", log: false });
    const out = await assemble(handle, { provider: "openai" });
    assert.equal(
      out.sections.find((s) => s.name === PERSONA_SECTION).text,
      "DEPLOYMENT PERSONA",
    );
  }));

await test("missing persona file never throws and never clears the slot", async () => {
  const handle = fakeContext();
  apply(handle.ctx, {
    localPersonaFile: "Z:\\missing\\local.md",
    cloudPersonaFile: "Z:\\missing\\cloud.md",
    log: false,
  });
  const out = await assemble(handle, { provider: "ollama" });
  assert.equal(
    out.sections.find((s) => s.name === PERSONA_SECTION).text,
    "DEPLOYMENT PERSONA",
  );
});

await test("an agent with no provider route is treated as cloud", () =>
  withPersonas(async ({ local, cloud }) => {
    const handle = fakeContext();
    apply(handle.ctx, { localPersonaFile: local, cloudPersonaFile: cloud, log: false });
    const out = await assemble(handle, { provider: undefined });
    assert.equal(
      out.sections.find((s) => s.name === PERSONA_SECTION).text,
      "CLOUD PERSONA",
    );
  }));

await test("persona file edits are picked up on the next assembly", () =>
  withPersonas(async ({ local, cloud }) => {
    const handle = fakeContext();
    apply(handle.ctx, { localPersonaFile: local, cloudPersonaFile: cloud, log: false });
    assert.equal(
      (await assemble(handle, { provider: "ollama" })).sections.find(
        (s) => s.name === PERSONA_SECTION,
      ).text,
      "LOCAL PERSONA",
    );
    // Ensure the mtime/size probe sees a change.
    writeFileSync(local, "LOCAL PERSONA v2 !!", "utf8");
    const out = await assemble(handle, { provider: "ollama" });
    assert.equal(
      out.sections.find((s) => s.name === PERSONA_SECTION).text,
      "LOCAL PERSONA v2 !!",
    );
  }));

await test("the pre-step hook is no longer used", () => {
  const handle = fakeContext();
  apply(handle.ctx, { localPersonaFile: "", cloudPersonaFile: "", log: false });
  assert.equal(handle.listeners.has("agent/pre-step"), false, "must not hook pre-step");
  assert.equal(handle.listeners.has(ASSEMBLE_EVENT), true, "must hook the assemble waterfall");
});

console.log(`\n${passed} smoke tests passed`);
