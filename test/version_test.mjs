import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { VERSION } from "../Project.js";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function readPkg() {
    const url = new URL("../package.json", import.meta.url);
    const raw = await readFile(fileURLToPath(url), "utf8");
    return JSON.parse(raw);
}

test("VERSION is a semver string", () => {
    assert.equal(typeof VERSION, "string");
    assert.match(VERSION, SEMVER_RE);
});

test("VERSION strictly equals package.json version", async () => {
    const pkg = await readPkg();
    assert.equal(VERSION, pkg.version);
});
