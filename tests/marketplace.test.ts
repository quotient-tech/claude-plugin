// The marketplace manifest and each plugin it lists must agree, or the
// enabledPlugins id that engineers' settings refer to silently changes.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

interface Entry {
  name: string;
  source: unknown;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Checks an entry's source and finds the plugin directory it names in this checkout.
 *
 * @param source - The `source` value of a marketplace entry.
 * @returns The plugin directory, relative to the repo root.
 * @throws AssertionError when the source is malformed or names no plugin directory.
 */
function pluginDir(source: unknown): string {
  let dir: string;
  if (typeof source === "string") {
    assert.match(source, /^\.\//);
    dir = source;
  } else if ((source as { source?: unknown } | null)?.source === "git-subdir") {
    const { url, path } = source as { url: unknown; path: unknown };
    assert.equal(url, "quotient-tech/claude-plugin", `git-subdir url ${String(url)} isn't this repo`);
    assert.equal(typeof path, "string", "git-subdir path must be a string");
    dir = path as string;
  } else {
    assert.fail(`unsupported source ${JSON.stringify(source)}`);
  }
  assert.ok(!dir.split("/").includes(".."), `${dir} contains ..`);
  const manifestPath = join(ROOT, dir, ".claude-plugin/plugin.json");
  assert.ok(existsSync(manifestPath), `${dir} has no .claude-plugin/plugin.json`);
  if (typeof source !== "string") {
    // The marketplace on main must install exactly the release that set this version.
    const expected = `v${String(readJson(manifestPath).version)}`;
    const { ref } = source as { ref: unknown };
    assert.equal(ref, expected, `git-subdir ref ${String(ref)} isn't ${expected}`);
  }
  return dir;
}

const marketplace = readJson(join(ROOT, ".claude-plugin/marketplace.json"));
const entries = marketplace.plugins as Entry[];

test("the marketplace is named quotient and lists at least one plugin", () => {
  assert.equal(marketplace.name, "quotient");
  assert.ok(Array.isArray(entries) && entries.length > 0);
});

for (const entry of entries) {
  test(`${entry.name}: source names a plugin directory in this repo`, () => {
    pluginDir(entry.source);
  });

  test(`${entry.name}: entry name matches the plugin manifest name`, () => {
    const manifest = readJson(join(ROOT, pluginDir(entry.source), ".claude-plugin/plugin.json"));
    assert.equal(manifest.name, entry.name);
  });

  test(`${entry.name}: plugin version is semver`, () => {
    const manifest = readJson(join(ROOT, pluginDir(entry.source), ".claude-plugin/plugin.json"));
    assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/);
  });
}

// Releases replace a relative source with this shape, pinned to the release tag.
const version = String(readJson(join(ROOT, "plugins/quotient/.claude-plugin/plugin.json")).version);
const released = {
  source: "git-subdir",
  url: "quotient-tech/claude-plugin",
  path: "plugins/quotient",
  ref: `v${version}`,
};

test("a git-subdir source pinned to the plugin's version is accepted", () => {
  assert.equal(pluginDir(released), "plugins/quotient");
});

test("a git-subdir source whose ref isn't the plugin's version is rejected", () => {
  assert.throws(() => pluginDir({ ...released, ref: "v999.0.0" }), /ref v999\.0\.0 isn't/);
});

test("a git-subdir source for another repo is rejected", () => {
  assert.throws(() => pluginDir({ ...released, url: "someone/else" }), /url someone\/else isn't this repo/);
});

test("a git-subdir source whose path leaves the repo is rejected", () => {
  assert.throws(() => pluginDir({ ...released, path: "plugins/../.." }), /contains \.\./);
});

test("any other source shape is rejected", () => {
  assert.throws(() => pluginDir({ source: "github", repo: "quotient-tech/claude-plugin" }), /unsupported source/);
});
