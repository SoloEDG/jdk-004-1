import type {
  GameDoc,
  Input,
  ReplayFile,
  ReplayUpgradeEvent,
} from "../../../shared/types";
import { RULES_VERSION, TICK_DURATION } from "../../../shared/rules";
import { checksum, packInput, encodeStream, ReplayError } from "./codec";

const FORMAT_VERSION = 1;

/**
 * 实时行动的输入录制器。
 *
 * 只在模拟真正前进一步（固定步长 1/60）时记录一次输入，与实时帧率无关；
 * 升级是离散事件，记录发生 tick、当时候选与玩家选择，用于回放时无随机地恢复面板。
 */
export class InputRecorder {
  private readonly frames: number[] = [];
  private readonly upgrades: ReplayUpgradeEvent[] = [];
  private tick = 0;
  private recordId: string;

  constructor(recordId: string) {
    this.recordId = recordId;
  }

  /** 每执行一次固定步长模拟调用一次，记录该步使用的输入。 */
  recordTick(input: Input): void {
    this.frames.push(packInput(input));
    this.tick++;
  }

  /** 记录一次升级选择；choices 为当时面板候选，chosen 为玩家选择。 */
  recordUpgrade(tick: number, choices: string[], chosen: string): void {
    this.upgrades.push({ tick, choices: [...choices], chosen });
  }

  getTick(): number {
    return this.tick;
  }

  /** 行动结束后生成可持久化/导出的回放档案。 */
  build(doc: GameDoc): ReplayFile {
    if (this.tick !== this.frames.length)
      throw new ReplayError("录制 tick 数与输入帧不一致");
    const withoutChecksum: Omit<ReplayFile, "checksum"> = {
      kind: "void-signal.replay",
      rulesVersion: RULES_VERSION,
      formatVersion: FORMAT_VERSION,
      recordId: this.recordId,
      seed: doc.initialSeed,
      ticks: this.tick,
      inputStream: encodeStream(Uint32Array.from(this.frames)),
      upgrades: this.upgrades,
      summary: {
        duration: Math.round(this.tick * TICK_DURATION * 1000) / 1000,
        wave: doc.wave,
        level: doc.level,
        kills: doc.stats.kills,
        damage: Math.round(doc.stats.damage),
        victory: doc.victory,
      },
    };
    return { ...withoutChecksum, checksum: checksum(withoutChecksum) };
  }
}
