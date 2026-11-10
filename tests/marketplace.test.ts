// The marketplace manifest and each plugin it lists must agree, or the
// enabledPlugins id that engineers' settings refer to silently changes.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

interface Entry {
  name: string;
  source: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const marketplace = readJson(join(ROOT, ".claude-plugin/marketplace.json"));
const entries = marketplace.plugins as Entry[];

test("the marketplace is named quotient and lists at least one plugin", () => {
  assert.equal(marketplace.name, "quotient");
  assert.ok(Array.isArray(entries) && entries.length > 0);
});

for (const entry of entries) {
  test(`${entry.name}: source is a ./ path without .. to a plugin directory`, () => {
    assert.match(entry.source, /^\.\//);
    assert.ok(!entry.source.split("/").includes(".."), entry.source);
    assert.ok(
      existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json")),
      `${entry.source} has no .claude-plugin/plugin.json`,
    );
  });

  test(`${entry.name}: entry name matches the plugin manifest name`, () => {
    const manifest = readJson(join(ROOT, entry.source, ".claude-plugin/plugin.json"));
    assert.equal(manifest.name, entry.name);
  });

  test(`${entry.name}: plugin version is semver`, () => {
    const manifest = readJson(join(ROOT, entry.source, ".claude-plugin/plugin.json"));
    assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
  });
}
