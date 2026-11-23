/**
 * Smoke tests for dsh-local-persona-switch.
 * Run with: node test/smoke.mjs
 *
 * These exercise the pure helpers plus a fake Cordis context that drives the
 * `agent/pre-step` hook, so the plugin is verified without a live harness.
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
  PERSONA_SECTION,
} from "../index.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

/** Minimal Cordis-like context capturing registrations and effects. */
function fakeContext() {
  const listeners = new Map();
  const sections = [];
  const contexts = [];
  const logs = [];
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
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
    },
  };
  const systemPrompt = {
    section: (section) => {
      sections.push(section);
      return () => {};
    },
    context: (context) => {
      contexts.push(context);
      return () => {};
    },
  };
  const emit = async (agent) => {
    const handler = listeners.get("agent/pre-step");
    assert.ok(handler, "agent/pre-step listener registered");
    return handler({ agent, messages: [], step: 1 }, async () => ({
      kind: "enter",
      messages: [],
    }));
  };
  return { ctx, systemPrompt, emit, sections, contexts, logs };
}

/** Agent double exposing a per-agent systemPrompt scope. */
function fakeAgent(provider, model) {
  const scopedSections = [];
  return {
    provider,
    model,
    scopedSections,
    ctx: {
      get: (name) =>
        name === "systemPrompt"
          ? {
              section: (section) => {
                scopedSections.push(section);
                return () => {};
              },
            }
          : undefined,
    },
  };
}

await test("defaults are environment-agnostic", () => {
  const cfg = resolveConfig({});
  assert.ok(cfg.localPersonaFile.endsWith("AGENTS-local.md"));
  assert.ok(cfg.cloudPersonaFile.endsWith("AGENTS-cloud.md"));
  assert.ok(cfg.localPatterns.includes("ollama"));
  assert.ok(cfg.localHosts.includes("127.0.0.1"));
  // Defaults must derive from homedir()/$DSH_HOME, never a fixed machine path.
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
  assert.equal(isLocalProvider("local-moe", cfg), true);
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
  assert.equal(isLocalRoute({ provider: "x" }, cfg), false);
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

await test("pre-step swaps persona for a local route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persona-"));
  try {
    const local = join(dir, "local.md");
    const cloud = join(dir, "cloud.md");
    writeFileSync(local, "LOCAL PERSONA", "utf8");
    writeFileSync(cloud, "CLOUD PERSONA", "utf8");

    const { ctx, emit, sections, contexts } = fakeContext();
    apply(ctx, { localPersonaFile: local, cloudPersonaFile: cloud });

    const agent = fakeAgent("ollama", "qwen3:4b");
    await emit(agent);

    assert.equal(agent.scopedSections.length, 1);
    assert.equal(agent.scopedSections[0].name, PERSONA_SECTION);
    assert.equal(agent.scopedSections[0].order, 0);
    assert.equal(agent.scopedSections[0].text, "LOCAL PERSONA");
    assert.equal(sections.length, 0, "no global fallback when scoped works");
    assert.equal(contexts.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("pre-step swaps persona back for a cloud route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persona-"));
  try {
    const local = join(dir, "local.md");
    const cloud = join(dir, "cloud.md");
    writeFileSync(local, "LOCAL PERSONA", "utf8");
    writeFileSync(cloud, "CLOUD PERSONA", "utf8");

    const { ctx, emit } = fakeContext();
    apply(ctx, { localPersonaFile: local, cloudPersonaFile: cloud });

    const agent = fakeAgent("openai", "gpt-x");
    await emit(agent);

    assert.equal(agent.scopedSections.at(-1).text, "CLOUD PERSONA");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("agent without a scoped systemPrompt falls back to global context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persona-"));
  try {
    const local = join(dir, "local.md");
    writeFileSync(local, "LOCAL PERSONA", "utf8");

    const { ctx, emit, contexts } = fakeContext();
    apply(ctx, {
      localPersonaFile: local,
      cloudPersonaFile: "",
    });

    await emit({ provider: "ollama", model: "m" });
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].text, "LOCAL PERSONA");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("missing persona file never throws", async () => {
  const { ctx, emit } = fakeContext();
  apply(ctx, {
    localPersonaFile: "Z:\\missing\\local.md",
    cloudPersonaFile: "Z:\\missing\\cloud.md",
  });
  await emit(fakeAgent("ollama", "m"));
});

await test("repeated steps do not re-register unchanged persona", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persona-"));
  try {
    const local = join(dir, "local.md");
    writeFileSync(local, "LOCAL PERSONA", "utf8");

    const { ctx, emit } = fakeContext();
    apply(ctx, { localPersonaFile: local, cloudPersonaFile: "" });

    const agent = fakeAgent("ollama", "m");
    await emit(agent);
    await emit(agent);

    assert.equal(agent.scopedSections.length, 1, "deduplicated by digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} smoke tests passed`);
