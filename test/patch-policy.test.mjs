import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_POLICY,
  GATE_PATCHES,
  POLICY_MODES,
  isGate,
  normalizePolicy,
  policyNote,
  selectPatches,
  skippedPatches,
} from "../lib/patch-policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const coreSource = readFileSync(join(here, "..", "lib", "core.js"), "utf8");

/** 从 core.js 源码静态提取补丁 id，避免测试依赖 yaml/cordis 运行时。 */
function sourcePatchIds() {
  const ids = new Set();
  for (const match of coreSource.matchAll(/\bid:\s*(\d+)\s*,\s*\n?\s*name:\s*"[A-Z0-9_]+"/g)) {
    ids.add(Number(match[1]));
  }
  return ids;
}

const fakePatches = GATE_PATCHES.map((id) => ({ id, name: `GATE_${id}` }))
  .concat([{ id: 1, name: "SAFE_1" }, { id: 4, name: "SAFE_4" }, { id: 33, name: "TALK_33" }]);

test("默认策略是 safe，且模式只有 safe/full", () => {
  assert.equal(DEFAULT_POLICY, "safe");
  assert.deepEqual([...POLICY_MODES], ["safe", "full"]);
});

test("safe 策略剔除全部 gate 补丁，保留其余", () => {
  const kept = selectPatches(fakePatches, "safe");
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((p) => p.id).sort((a, b) => a - b), [1, 4, 33]);
  assert.ok(kept.every((p) => !isGate(p.id)));
});

test("full 策略原样返回，且返回副本而非同一引用", () => {
  const all = [...fakePatches];
  const kept = selectPatches(all, "full");
  assert.equal(kept.length, all.length);
  assert.notEqual(kept, all);
});

test("非法或缺失策略回落到 safe", () => {
  for (const value of [undefined, null, "", "FULLL", 0, {}, "  "]) {
    assert.equal(normalizePolicy(value), "safe");
  }
  assert.equal(normalizePolicy(" FULL "), "full");
  assert.equal(normalizePolicy("Safe"), "safe");
});

test("空输入与畸形条目不会抛错", () => {
  assert.deepEqual(selectPatches(undefined, "safe"), []);
  assert.deepEqual(selectPatches(null, "full"), []);
  // 非 gate 条目一律保留，包括缺 id 的畸形行
  assert.equal(selectPatches([null, {}, { id: 33 }], "safe").length, 3);
  // 字符串 id 也按数值命中
  assert.equal(selectPatches([{ id: "5" }], "safe").length, 0);
});

test("skippedPatches 与 selectPatches 互补", () => {
  const kept = selectPatches(fakePatches, "safe");
  const skipped = skippedPatches(fakePatches, "safe");
  assert.equal(kept.length + skipped.length, fakePatches.length);
  assert.deepEqual(skippedPatches(fakePatches, "full"), []);
});

test("gate 编号在上游补丁表里真实存在（上游改 id 时这里失败）", () => {
  const ids = sourcePatchIds();
  assert.ok(ids.size > 50, `解析到的补丁 id 太少：${ids.size}`);
  const missing = GATE_PATCHES.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `这些 gate 编号在上游 core.js 中已不存在：${missing.join(", ")}`);
});

test("policyNote 反映当前策略", () => {
  assert.match(policyNote("safe"), /skip|跳过/);
  assert.match(policyNote("full"), /full/);
});
