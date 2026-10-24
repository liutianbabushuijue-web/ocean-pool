// stepx 推送契约的纯函数测试：不碰数据库、不发请求。
// 运行：npm run test:standalone  （或 node --import ./tests/standalone.ts --test modules/stepx-push/tests/*.test.ts）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  articleIdOf,
  decodeCursor,
  encodeCursor,
  externalIdOf,
  sign,
  tokenMatches,
  tombstoneOf,
  validCron,
  verifies,
  type StepxItem,
} from "../payload.ts";

test("externalId 可逆，且带命名空间前缀", () => {
  const id = "aB3-x_y";
  assert.equal(externalIdOf(id), "aihot:aB3-x_y");
  assert.equal(articleIdOf(externalIdOf(id)), id);
  assert.equal(articleIdOf("other:1"), null);
});

test("游标编码同一毫秒的多条不会互相覆盖", () => {
  const at = new Date("2026-10-23T04:00:00.000Z");
  const a = encodeCursor(at, "a");
  const b = encodeCursor(at, "b");
  assert.notEqual(a, b);
  assert.deepEqual(decodeCursor(a), { at, id: "a" });
  assert.deepEqual(decodeCursor(b), { at, id: "b" });
});

test("坏游标返回 null，不会抛错", () => {
  const valid = encodeCursor(new Date("2026-10-23T04:00:00.000Z"), "abc");
  for (const bad of [
    "", "!!!", `${valid}!`, `${valid}\n`, `${valid}=`,
    // 非规范的末尾位：Node 的宽松解码会把 Yh 和 Yg 都还原成同一个字节。
    "MHxhYh",
    ...["abc", "x|not an id!!", "8640000000000001|a", "9007199254740992|a",
      "1.5|a", "1e3|a", "0x10|a", " |a", "0|", "0|a|b"].map((text) => Buffer.from(text).toString("base64url")),
  ]) {
    assert.equal(decodeCursor(bad), null, `应拒绝坏游标：${JSON.stringify(bad)}`);
  }
});

test("旧毫秒游标保持兼容，包括 Unix epoch 与有效 Date 边界", () => {
  for (const ms of [-8640000000000000, -1, 0, 1792728000000, 8640000000000000]) {
    const cursor = Buffer.from(`${ms}|legacy-1`).toString("base64url");
    assert.deepEqual(decodeCursor(cursor), { at: new Date(ms), id: "legacy-1" });
  }
});

test("签名只由 rawBody+timestamp 决定，换时间戳就失效", () => {
  const body = JSON.stringify({ schema: "stepx.ocean.v1", items: [{ title: "海温" }] });
  const at = 1_780_000_000;
  const sig = sign(body, at, "s3cret-s3cret-s3cret");
  assert.equal(verifies(body, at, sig, "s3cret-s3cret-s3cret"), true);
  assert.equal(verifies(body, at + 1, sig, "s3cret-s3cret-s3cret"), false);
  assert.equal(verifies(body + " ", at, sig, "s3cret-s3cret-s3cret"), false);
  assert.equal(verifies(body, at, sig, "another-secret-value"), false);
});

test("token 比较拒绝空值与短值，且长度不同不抛错", () => {
  assert.equal(tokenMatches(undefined, null), false);
  assert.equal(tokenMatches("short", "short"), false); // 短于 16 位一律拒绝
  const good = "0123456789abcdef0123";
  assert.equal(tokenMatches(good, good), true);
  assert.equal(tokenMatches(good + "x", good), false);
  assert.equal(tokenMatches("", good), false);
});

test("撤回条目只保留身份与时间", () => {
  const item: StepxItem = tombstoneOf("abc", new Date("2026-10-23T00:00:00.000Z"));
  assert.equal(item.tombstone, true);
  assert.equal(item.externalId, "aihot:abc");
  assert.equal(item.updatedAt, "2026-10-23T00:00:00.000Z");
  for (const key of ["title", "summary", "originalUrl", "bodyText", "score", "storyId"] as const) {
    assert.equal(item[key], null, `${key} 应该清空`);
  }
  assert.deepEqual(item.tags, []);
});

test("cron 只接受保守写法，坏表达式回退默认值", () => {
  assert.equal(validCron("*/30 * * * *"), "*/30 * * * *");
  assert.equal(validCron("0 7 * * *"), "0 7 * * *");
  assert.equal(validCron("15,45 * * * 1-5"), "15,45 * * * 1-5");
  assert.equal(validCron("0-59/10 0,12,23 1-31 1,6,12 0-7"), "0-59/10 0,12,23 1-31 1,6,12 0-7");
  assert.equal(validCron("0 7 29 2 *"), "0 7 29 2 *");
  // 回退：空、段数不对、含非法字符、分钟越界
  assert.equal(validCron(undefined), "*/30 * * * *");
  assert.equal(validCron(""), "*/30 * * * *");
  assert.equal(validCron("* * *"), "*/30 * * * *");
  assert.equal(validCron("0 7 * * *; rm -rf /"), "*/30 * * * *");
  assert.equal(validCron("99 * * * *"), "*/30 * * * *");
  assert.equal(validCron("abc * * * *"), "*/30 * * * *");
  assert.equal(validCron("bogus", "0 7 * * *"), "0 7 * * *");
  for (const bad of [
    "0 24 * * *", "0 * 0 * *", "0 * 32 * *", "0 * * 0 *", "0 * * 13 *", "0 * * * 8",
    "*/0 * * * *", "0 */0 * * *", "0 * */0 * *", "0 * * */0 *", "0 * * * */0",
    "30-10 * * * *", "0 20-7 * * *", "0 * 15-1 * *", "0 * * 12-1 *", "0 * * * 5-1",
    "0 7 31 2 *", "0 7 31 4 *", "0 7 * * * *",
  ]) {
    assert.equal(validCron(bad, "0 7 * * *"), "0 7 * * *", `应拒绝坏 cron：${bad}`);
  }
});
