export type Vec = { x: number; y: number };
export type Phase = "ready" | "playing" | "paused" | "upgrade" | "ended";
export type WeaponId = "pulse" | "orbit" | "nova";
export interface Player extends Vec {
  hp: number;
  maxHp: number;
  speed: number;
  radius: number;
  invincible: number;
}
export interface Enemy extends Vec {
  id: number;
  kind: "chaser" | "shooter" | "elite";
  hp: number;
  maxHp: number;
  radius: number;
  cooldown: number;
}
export interface Bullet extends Vec {
  id: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;
  owner: "player" | "enemy";
  weapon: WeaponId | "enemy";
  pierce: number;
  hit: number[];
}
export interface Drop extends Vec {
  id: number;
  kind: "xp" | "heal" | "magnet";
  value: number;
  life: number;
}
export interface Weapon {
  id: WeaponId;
  level: number;
  cooldown: number;
}
export interface Upgrade {
  id: string;
  name: string;
  description: string;
  category: string;
  max: number;
}
export interface RunStats {
  kills: number;
  damage: number;
  taken: number;
  collected: number;
  shots: number;
  byWeapon: Record<WeaponId, number>;
}
export interface RunRecord {
  id: string;
  duration: number;
  wave: number;
  level: number;
  kills: number;
  damage: number;
  weapons: string[];
  victory: boolean;
  /**
   * 是否存在可播放的行动回放。旧档案没有该字段（按 false 处理），
   * 此时档案只展示原汇总，不提供播放/导出入口。
   */
  hasReplay?: boolean;
}
/** 一次离散的升级选择，锚定到发生时的固定步长 tick（已执行的模拟步数）。 */
export interface ReplayUpgradeEvent {
  tick: number;
  /** 当时向玩家展示的候选（用于恢复升级面板与校验，不依赖重放时再随机）。 */
  choices: string[];
  /** 玩家实际选择的升级 id。 */
  chosen: string;
}
/** 回放结束时的战绩快照，用于重放后比对、防止统计对不上。 */
export interface ReplaySummary {
  duration: number;
  wave: number;
  level: number;
  kills: number;
  damage: number;
  victory: boolean;
}
/**
 * 行动回放档案。
 *
 * 只记录输入（每 tick 的移动/瞄准/开火）与离散升级事件，而不是每帧保存整个战场，
 * 因此长局也不会膨胀。配合原始随机种子与规则版本即可确定性重放战斗。
 */
export interface ReplayFile {
  kind: "void-signal.replay";
  /** 录制时的规则版本，播放端不支持时必须中止。 */
  rulesVersion: number;
  /** 录制时的协议版本（回放文件结构本身）。 */
  formatVersion: number;
  /** 对应的行动战绩 id，用于与档案关联。 */
  recordId: string;
  /** 本局使用的原始随机种子。 */
  seed: number;
  /** 已录制的固定步长 tick 数。 */
  ticks: number;
  /** base64 编码的逐 tick 输入位流（每 tick 4 字节）。 */
  inputStream: string;
  /** 离散升级选择（按 tick 升序）。 */
  upgrades: ReplayUpgradeEvent[];
  /** 录制结束时的战绩快照与校验和。 */
  summary: ReplaySummary;
  checksum: string;
}
export interface GameDoc {
  version: 1;
  seed: number;
  initialSeed: number;
  nextId: number;
  phase: Phase;
  time: number;
  player: Player;
  enemies: Enemy[];
  bullets: Bullet[];
  drops: Drop[];
  weapons: Weapon[];
  upgrades: Record<string, number>;
  choices: string[];
  xp: number;
  level: number;
  pendingLevels: number;
  wave: number;
  waveTime: number;
  spawnBudget: number;
  stats: RunStats;
  records: RunRecord[];
  notice: string;
  victory: boolean;
  /**
   * 回放驱动的战场为 true。该战场的结算不得新增真实战绩，
   * 也不得写入 localStorage，避免污染档案统计。
   */
  replay?: boolean;
  /** 本局行动预设的战绩 id，用于关联实时录制的回放；不设置则结算时自动生成。 */
  recordId?: string;
}
export interface Input {
  x: number;
  y: number;
  aim: Vec;
  firing: boolean;
}
export interface KillEvent {
  enemy: Enemy;
  weapon: WeaponId;
}
export interface FrameEvents {
  weaponDamage?: Partial<Record<WeaponId, number>>;
  kills: KillEvent[];
  damage: number;
  taken: number;
  shots: number;
  collected: number;
}
export const WIDTH = 1000;
export const HEIGHT = 650;
