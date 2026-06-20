import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const swSource = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");

test("service worker does not automatically skip waiting during install", () => {
  const installBlock = swSource.match(/self\.addEventListener\("install"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.ok(installBlock.includes("addEventListener(\"install\""));
  assert.equal(installBlock.includes("skipWaiting"), false);
});

test("service worker does not claim clients during activation", () => {
  const activateBlock = swSource.match(/self\.addEventListener\("activate"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.ok(activateBlock.includes("addEventListener(\"activate\""));
  assert.equal(activateBlock.includes("clients.claim"), false);
});

test("service worker update activation is explicit", () => {
  assert.ok(swSource.includes("SARAH_SKIP_WAITING"));
  assert.ok(swSource.includes("PULSEPOINT_SKIP_WAITING"));
});
