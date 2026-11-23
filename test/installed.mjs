/**
 * Real-runtime verification against the installed @deepseek-ai/cordis.
 *
 * Unlike smoke.mjs (which fakes the context), this mounts the plugin into an
 * actual Cordis Context and drives the real `system-prompt/assemble` waterfall,
 * proving the event name and waterfall signature are correct.
 *
 * Run with: node test/installed.mjs
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Resolve from the real profile, exactly as the app would.
const profile = process.env.DSH_PROFILE_DIR
  ?? join(homedir(), ".dsh", "profiles", "desktop");
const req = createRequire(join(profile, "package.json"));

const { Context } = await import(pathToFileURL(req.resolve("@deepseek-ai/cordis")).href);
const plugin = await import(pathToFileURL(req.resolve("dsh-local-persona-switch")).href);

assert.equal(typeof plugin.default, "function", "default export must be apply()");

const dir = mkdtempSync(join(tmpdir(), "persona-installed-"));
const local = join(dir, "local.md");
const cloud = join(dir, "cloud.md");
writeFileSync(local, "LOCAL-PERSONA-TEXT", "utf8");
writeFileSync(cloud, "CLOUD-PERSONA-TEXT", "utf8");

const ctx = new Context();
ctx.plugin(plugin.default, {
  localPersonaFile: local,
  cloudPersonaFile: cloud,
  log: false,
});

// Cordis loads plugins asynchronously; listeners are not registered until the
// plugin's fiber settles. Dispatching before that sees no listener at all.
await new Promise((resolve) => setTimeout(resolve, 300));

/** Drive the real waterfall exactly as dsh-agent-loop does. */
const run = async (provider) => {
  const seed = {
    sections: [
      { name: "harness:identity", text: "IDENTITY" },
      { name: "deployment:persona", text: "DEPLOYMENT-PERSONA-TEXT" },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
  const assembleContext = { agent: { options: { provider, model: "m" } } };
  const out = await ctx.waterfall(
    "system-prompt/assemble",
    seed,
    assembleContext,
    async () => seed,
  );
  return out.sections.find((s) => s.name === "deployment:persona")?.text ?? "(none)";
};

const cases = [
  ["ollama", "LOCAL-PERSONA-TEXT"],
  ["llama-cpp", "LOCAL-PERSONA-TEXT"],
  ["openai", "CLOUD-PERSONA-TEXT"],
  ["workbuddy", "CLOUD-PERSONA-TEXT"],
];

let failures = 0;
for (const [provider, expected] of cases) {
  let actual;
  try {
    actual = await run(provider);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${provider.padEnd(10)} threw: ${error}`);
    continue;
  }
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${provider.padEnd(10)} -> ${actual}`);
}

rmSync(dir, { recursive: true, force: true });
await ctx.dispose?.();

if (failures > 0) {
  console.log(`\n${failures} installed-runtime case(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\ninstalled-runtime waterfall verified");
}
