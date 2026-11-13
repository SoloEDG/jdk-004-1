import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun } from "../src/shared/createRun";
import { simulate } from "../src/app/simulate";
import { chooseUpgrade } from "../src/features/progression";
import { InputRecorder } from "../src/features/replay/lib/recorder";
import { ReplayPlayer } from "../src/features/replay/lib/player";
import { ReplayError, validateReplay, checksum } from "../src/features/replay/lib/codec";
import {
  parseReplayJSON,
  exportReplayJSON,
} from "../src/features/replay/lib/storage";
import type { Input } from "../src/shared/types";
import { RULES_VERSION, TICK_DURATION } from "../src/shared/rules";

// 确定性的伪玩家：基于 tick 产生移动/瞄准输入，保证两次运行输入完全相同。
function scriptedInput(tick: number): Input {
  const x = tick % 120 < 60 ? 1 : -1;
  const y = tick % 180 < 90 ? 1 : -1;
  return {
    x,
    y,
    aim: { x: 500 + Math.sin(tick / 17) * 300, y: 325 },
    firing: tick % 3 === 0,
  };
}

/** 驱动一局实时行动并同步录制，直到结束或达到 tick 上限。 */
function playAndRecord(maxTicks = 6000) {
  const doc = createRun(777, []);
  doc.recordId = `777-test`;
  doc.phase = "playing";
  const recorder = new InputRecorder(doc.recordId);
  let tick = 0;
  while (doc.phase !== "ended" && tick < maxTicks) {
    const input = scriptedInput(tick);
    recorder.recordTick(input);
    simulate(doc, input, TICK_DURATION);
    tick++;
    if (doc.phase === "upgrade") {
      recorder.recordUpgrade(recorder.getTick(), doc.choices, doc.choices[0]);
      chooseUpgrade(doc, doc.choices[0]);
      // 一次拾取可能排队多个等级，需要依次选完。
      while (doc.phase === "upgrade") {
        recorder.recordUpgrade(recorder.getTick(), doc.choices, doc.choices[0]);
        chooseUpgrade(doc, doc.choices[0]);
      }
    }
  }
  return { doc, replay: recorder.build(doc), ticks: tick };
}

test("录制的输入帧数与模拟步数一致且带固定规则版本与种子", () => {
  const { replay, ticks } = playAndRecord(240);
  assert.equal(replay.ticks, ticks);
  assert.equal(replay.rulesVersion, RULES_VERSION);
  assert.equal(replay.seed, 777);
  assert.ok(replay.inputStream.length > 0);
  assert.equal(typeof replay.checksum, "string");
});

test("确定性重放完整复现战场状态与战绩，且不新增任何真实战绩", () => {
  const { doc: live, replay } = playAndRecord(3000);
  const player = new ReplayPlayer(replay);
  assert.equal(player.doc.replay, true);
  while (!player.isDone && !player.isAborted) player.step();
  const r = player.doc;
  assert.equal(r.phase, "ended");
  assert.equal(r.time, live.time);
  assert.equal(r.wave, live.wave);
  assert.equal(r.level, live.level);
  assert.equal(r.stats.kills, live.stats.kills);
  assert.equal(r.stats.damage, live.stats.damage);
  assert.equal(r.victory, live.victory);
  // 关键：回放结算不得写入真实战绩。
  assert.equal(r.records.length, 0);
  assert.deepEqual(r.player, live.player);
});

test("seek 逐帧定位与连续播放得到完全相同的状态", () => {
  const { replay } = playAndRecord(1200);
  const a = new ReplayPlayer(replay);
  a.seek(537);
  const snapshot = JSON.parse(JSON.stringify(a.doc));
  const b = new ReplayPlayer(replay);
  for (let i = 0; i < 537; i++) b.step();
  const continuous = JSON.parse(JSON.stringify(b.doc));
  // recordId 仅实时行动用于关联战绩，回放战场不产生该字段，与确定性无关。
  delete snapshot.recordId;
  delete continuous.recordId;
  assert.deepEqual(continuous, snapshot);
  assert.equal(b.currentTick, 537);
});

test("升级 tick 恢复当时候选并自动应用录制选择", () => {
  const { replay } = playAndRecord(4000);
  assert.ok(replay.upgrades.length > 0, "脚本应在 4000 帧内触发至少一次升级");
  for (const u of replay.upgrades) {
    // 不变量：升级事件锚定的 tick 必须是已执行的合法步序号。
    assert.ok(u.tick >= 1 && u.tick <= replay.ticks);
    assert.ok(u.choices.includes(u.chosen));
  }
  const first = replay.upgrades[0];
  const player = new ReplayPlayer(replay);
  player.seek(first.tick);
  // seek 停在升级发生帧，候选已通过校验且选择已被自动应用，战场回到可推进状态。
  assert.equal(player.currentTick, first.tick);
  assert.equal(player.doc.phase, "playing");
  // 升级确实改变了等级。
  assert.ok(player.doc.level >= 2);
});

test("损坏的输入位流导致校验失败并中止，而不是静默跳过", () => {
  const { replay } = playAndRecord(600);
  const broken = { ...replay, inputStream: replay.inputStream.slice(0, -4) + "xxxx" };
  assert.throws(() => validateReplay(broken), ReplayError);
  assert.throws(() => new ReplayPlayer(broken), ReplayError);
});

test("不支持的规则版本立即中止播放", () => {
  const { replay } = replayWithChecksum({ rulesVersion: RULES_VERSION + 99 });
  assert.throws(() => new ReplayPlayer(replay), /规则版本不支持/);
});

test("篡改升级选择使重放发散时中止，避免统计对不上", () => {
  const { replay } = playAndRecord(3000);
  if (!replay.upgrades.length) return;
  const tampered = replayWithChecksum({
    upgrades: replay.upgrades.map((u, i) =>
      i === 0 ? { ...u, chosen: u.choices[u.choices.length - 1] } : u,
    ),
  });
  const player = new ReplayPlayer(tampered.replay);
  assert.throws(() => {
    while (!player.isDone) player.step();
  }, ReplayError);
  assert.equal(player.isAborted, true);
});

test("同一 tick 连升多级时整组升级队列都被确定性重放", () => {
  // 通过一次真实对局获得自洽的输入流，再用游戏真实的经验路径驱动出同 tick 多级。
  // 关键：经验必须来自模拟内部的掉落拾取，而不是向 doc 注入外部状态，
  // 否则回放从干净战场重建时无法复现，回放器会（正确地）拒绝脱节。
  const doc = createRun(31337, []);
  doc.recordId = "31337-multi";
  doc.phase = "playing";
  const recorder = new InputRecorder(doc.recordId);
  const stationary: Input = { x: 0, y: 0, aim: { x: 700, y: 325 }, firing: false };
  // 持续战斗，靠击杀掉落的经验晶体自然升级；站在中心让拾取半径覆盖掉落。
  let guard = 0;
  let sawMulti = false;
  while (doc.phase !== "ended" && guard++ < 6000) {
    const i = guard % 2 ? stationary : scriptedInput(recorder.getTick());
    recorder.recordTick(i);
    simulate(doc, i, TICK_DURATION);
    const tick = recorder.getTick();
    let count = 0;
    while (doc.phase === "upgrade") {
      recorder.recordUpgrade(tick, doc.choices, doc.choices[0]);
      chooseUpgrade(doc, doc.choices[0]);
      count++;
    }
    if (count > 1) sawMulti = true;
  }
  const file = recorder.build(doc);
  // 该脚本下多次拾取会累积连升；即便未触发，档案也必须能无损重放。
  const player = new ReplayPlayer(file);
  while (!player.isDone && !player.isAborted) player.step();
  assert.equal(player.isAborted, false);
  assert.equal(player.doc.level, doc.level);
  assert.deepEqual(player.doc.upgrades, doc.upgrades);
  assert.deepEqual(player.doc.weapons, doc.weapons);
  assert.equal(player.doc.records.length, 0);
  if (sawMulti)
    assert.ok(
      file.upgrades.some(
        (u, idx) => file.upgrades.some((v, j) => j !== idx && v.tick === u.tick),
      ),
      "录制中包含同 tick 的多升级事件",
    );
});

test("播放器把同一 tick 的多个升级事件分组保序，供单步整组消费", () => {
  const { replay } = playAndRecord(1500);
  // 构造一个同 tick 含两个事件的自洽档案（校验和重算），验证内部分组结构。
  const tick = replay.upgrades.length ? replay.upgrades[0].tick : 10;
  const synthetic: typeof replay = {
    ...replay,
    upgrades: [
      { tick, choices: replay.upgrades[0]?.choices ?? ["power"], chosen: replay.upgrades[0]?.chosen ?? "power" },
      { tick, choices: ["haste", "speed", "armor"], chosen: "haste" },
      ...replay.upgrades.slice(1),
    ],
  };
  synthetic.checksum = checksum({ ...synthetic, checksum: "" });
  const player = new ReplayPlayer(synthetic);
  const grouped = (
    player as unknown as {
      upgradesByTick: Map<number, unknown[]>;
    }
  ).upgradesByTick;
  assert.equal(grouped.get(tick)?.length, 2);
});

test("导出再导入得到等价档案，损坏 JSON 被拒绝且不抛非 ReplayError", () => {
  const { replay } = playAndRecord(600);
  const text = exportReplayJSON(replay);
  const back = parseReplayJSON(text);
  assert.equal(back.checksum, replay.checksum);
  assert.throws(() => parseReplayJSON("{not-json"), ReplayError);
});

// 在改动字段后重新计算校验和，用于构造“通过结构校验但内容被篡改”的档案。
function replayWithChecksum(patch: Record<string, unknown>) {
  const { replay } = playAndRecord(3000);
  const merged = { ...replay, ...patch } as typeof replay;
  const recomputed = checksum({ ...merged, checksum: "" });
  return { replay: { ...merged, checksum: recomputed } };
}
