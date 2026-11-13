import type {
  GameDoc,
  Input,
  Phase,
  ReplayFile,
  ReplayUpgradeEvent,
} from "../../../shared/types";
import { TICK_DURATION } from "../../../shared/rules";
import { createRun } from "../../../shared/createRun";
import { simulate } from "../../../app/simulate";
import { chooseUpgrade } from "../../progression";
import {
  decodeStream,
  ReplayError,
  unpackInput,
  validateReplay,
} from "./codec";

export { ReplayError };

export interface ReplaySnapshot {
  /** 当前已执行的模拟 tick 数（也即当前帧索引）。 */
  tick: number;
  phase: GameDoc["phase"];
  /** 当前 tick 触发的升级事件（用于恢复候选面板），否则为 null。 */
  upgradeEvent: ReplayUpgradeEvent | null;
  /** 是否已播放到档案末尾。 */
  done: boolean;
}

/**
 * 确定性回放播放器：用原始种子重建战场，按固定步长重放录制的输入。
 * 随机调用顺序由相同规则与相同输入保证一致，因此无需保存每帧战场。
 */
export class ReplayPlayer {
  readonly doc: GameDoc;
  private readonly frames: Input[];
  /** 每个 tick 可能排队多个升级（一次拾取连升多级），按 tick 分组保序。 */
  private readonly upgradesByTick: Map<number, ReplayUpgradeEvent[]>;
  private readonly file: ReplayFile;
  private tick = 0;
  private aborted = false;
  private abortReason: string | null = null;

  constructor(file: ReplayFile) {
    this.file = validateReplay(file);
    const packed = decodeStream(this.file.inputStream);
    this.frames = Array.from({ length: packed.length }, (_, i) =>
      unpackInput(packed[i]),
    );
    this.upgradesByTick = new Map();
    for (const u of this.file.upgrades) {
      const list = this.upgradesByTick.get(u.tick) ?? [];
      list.push(u);
      this.upgradesByTick.set(u.tick, list);
    }
    // 回放使用独立战场并标记 replay：结算不会写入真实战绩。
    this.doc = createRun(this.file.seed, [], true);
    this.doc.phase = "playing";
  }

  get length(): number {
    return this.file.ticks;
  }
  get currentTick(): number {
    return this.tick;
  }
  get isAborted(): boolean {
    return this.aborted;
  }
  get reason(): string | null {
    return this.abortReason;
  }
  get isDone(): boolean {
    return this.tick >= this.file.ticks;
  }

  private fail(message: string): never {
    this.aborted = true;
    this.abortReason = message;
    throw new ReplayError(message);
  }

  /** 前进一个固定步长；在升级 tick 自动依次应用录制的整组选择，保证随机顺序一致。 */
  step(): ReplaySnapshot {
    if (this.aborted) throw new ReplayError(this.abortReason ?? "回放已中止");
    if (this.tick >= this.file.ticks) return this.snapshot(null, true);
    const input = this.frames[this.tick];
    const phaseBefore: Phase = this.doc.phase;
    if (phaseBefore !== "playing")
      this.fail(`第 ${this.tick} 帧战场不在可推进状态，回放与录制脱节`);
    simulate(this.doc, input, TICK_DURATION);
    this.tick++;
    const queue = this.upgradesByTick.get(this.tick) ?? [];
    let applied: ReplayUpgradeEvent | null = null;
    // 同一 tick 可能连升多级：每一级都校验当时候选，再应用录制的选择。
    for (const event of queue) {
      const phase: Phase = this.doc.phase;
      if (phase !== "upgrade")
        this.fail(`第 ${this.tick} 帧应触发升级但战场未进入升级状态`);
      if (JSON.stringify(this.doc.choices) !== JSON.stringify(event.choices))
        this.fail(`第 ${this.tick} 帧升级候选与录制不一致，重放已发散`);
      if (!this.doc.choices.includes(event.chosen))
        this.fail(`第 ${this.tick} 帧的选择不在候选中，档案已损坏`);
      chooseUpgrade(this.doc, event.chosen);
      applied = event;
    }
    const phaseAfter: Phase = this.doc.phase;
    if (phaseAfter === "upgrade" && queue.length === 0)
      this.fail(`第 ${this.tick} 帧出现未录制的升级，档案不完整`);
    if (phaseAfter === "upgrade")
      this.fail(`第 ${this.tick} 帧升级选择未消费完录制队列，档案不完整`);
    if (this.tick === this.file.ticks) this.assertSummary();
    return this.snapshot(applied, this.tick >= this.file.ticks);
  }

  private assertSummary(): void {
    const s = this.file.summary;
    const eq = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;
    const d = this.doc;
    if (
      !eq(d.time, s.duration) ||
      d.wave !== s.wave ||
      d.level !== s.level ||
      d.stats.kills !== s.kills ||
      Math.round(d.stats.damage) !== s.damage ||
      d.victory !== s.victory
    )
      this.fail("重放结算与录制战绩不一致，已中止以避免统计对不上");
  }

  /** 逐帧定位：从头确定性重放到目标 tick（固定步长，结果与连续播放完全一致）。 */
  seek(targetTick: number): ReplaySnapshot {
    const target = Math.max(
      0,
      Math.min(this.file.ticks, Math.floor(targetTick)),
    );
    // 只能整体从头重放，避免反向跳转破坏随机流；单次重放仅计算、不渲染。
    this.reset();
    let lastEvent: ReplayUpgradeEvent | null = null;
    while (this.tick < target) {
      const snap = this.step();
      if (snap.upgradeEvent) lastEvent = snap.upgradeEvent;
    }
    return this.snapshot(lastEvent, this.tick >= this.file.ticks);
  }

  private reset(): void {
    this.tick = 0;
    this.aborted = false;
    this.abortReason = null;
    const fresh = createRun(this.file.seed, [], true);
    fresh.phase = "playing";
    Object.assign(this.doc, fresh);
  }

  private snapshot(
    upgradeEvent: ReplayUpgradeEvent | null,
    done: boolean,
  ): ReplaySnapshot {
    return {
      tick: this.tick,
      phase: this.doc.phase,
      upgradeEvent,
      done,
    };
  }
}
