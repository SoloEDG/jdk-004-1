import type { Input, ReplayFile } from "../../../shared/types";
import { RULES_VERSION } from "../../../shared/rules";

/**
 * 逐 tick 输入的确定性二进制编码。
 *
 * 每个 tick 固定 4 字节（一个 uint32），而不是保存整个战场：
 *   bits 0..9   aim.x 量化到 0..1023（战场宽 1000，精度约 1px）
 *   bits 10..19 aim.y 量化到 0..1023（战场高 650，精度 < 1px）
 *   bits 20..21 移动 x：-1/0/1 映射到 0/1/2
 *   bits 22..23 移动 y：-1/0/1 映射到 0/1/2
 *   bit  24     是否按住指针开火
 *
 * 4 分钟约 14400 tick ≈ 57.6KB 原始数据，base64 后约 77KB，且与战场实体数量无关，
 * 长局不会因为弹幕/敌人增多而膨胀。
 */
const BITS = { aimX: 10, aimY: 10, move: 2 };
const MASK_10 = 0x3ff;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
const moveToCode = (v: number): number => (v < 0 ? 0 : v > 0 ? 2 : 1);
const codeToMove = (c: number): number => (c === 0 ? -1 : c === 2 ? 1 : 0);

export function packInput(input: Input): number {
  const aimX = Math.round(clamp01(input.aim.x / 1000) * 1023);
  const aimY = Math.round(clamp01(input.aim.y / 650) * 1023);
  return (
    (aimX & MASK_10) |
    ((aimY & MASK_10) << BITS.aimX) |
    (moveToCode(input.x) << (BITS.aimX + BITS.aimY)) |
    (moveToCode(input.y) << (BITS.aimX + BITS.aimY + BITS.move)) |
    ((input.firing ? 1 : 0) << (BITS.aimX + BITS.aimY + BITS.move * 2))
  );
}

export function unpackInput(packed: number): Input {
  const aimX = packed & MASK_10;
  const aimY = (packed >> BITS.aimX) & MASK_10;
  const mx = codeToMove((packed >> (BITS.aimX + BITS.aimY)) & 0x3);
  const my = codeToMove((packed >> (BITS.aimX + BITS.aimY + BITS.move)) & 0x3);
  const firing =
    ((packed >> (BITS.aimX + BITS.aimY + BITS.move * 2)) & 0x1) === 1;
  return {
    x: mx,
    y: my,
    aim: { x: (aimX / 1023) * 1000, y: (aimY / 1023) * 650 },
    firing,
  };
}

export function encodeStream(packed: Uint32Array): string {
  const bytes = new Uint8Array(packed.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < packed.length; i++) view.setUint32(i * 4, packed[i], false);
  return bytesToBase64(bytes);
}

export function decodeStream(stream: string): Uint32Array {
  const bytes = base64ToBytes(stream);
  if (bytes.length % 4 !== 0)
    throw new ReplayError("输入位流长度损坏，无法按固定步长解析");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, false);
  return out;
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 自带 base64，避免依赖 btoa/Buffer，保证在浏览器与 Node 测试中行为一致。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triplet >> 18) & 63];
    out += B64_ALPHABET[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(triplet >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[triplet & 63] : "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== "string" || b64.length % 4 !== 0)
    throw new ReplayError("base64 数据格式不合法");
  const lookup = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++)
    lookup[B64_ALPHABET.charCodeAt(i)] = i;
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = Math.min(4, clean.length - i);
    let triplet = 0;
    for (let j = 0; j < n; j++) {
      const code = clean.charCodeAt(i + j);
      if (code > 127 || lookup[code] < 0)
        throw new ReplayError("base64 含非法字符，档案可能已损坏");
      triplet = (triplet << 6) | lookup[code];
    }
    triplet <<= (4 - n) * 6;
    if (p < out.length) out[p++] = (triplet >> 16) & 255;
    if (p < out.length && n >= 3) out[p++] = (triplet >> 8) & 255;
    if (p < out.length && n === 4) out[p++] = triplet & 255;
  }
  return out;
}

/** 32 位 FNV-1a，对回放关键内容求校验和；任一字节被改动都会失配。 */
export function checksum(file: Omit<ReplayFile, "checksum">): string {
  const json = JSON.stringify({
    rulesVersion: file.rulesVersion,
    formatVersion: file.formatVersion,
    recordId: file.recordId,
    seed: file.seed,
    ticks: file.ticks,
    inputStream: file.inputStream,
    upgrades: file.upgrades,
    summary: file.summary,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 回放相关错误一律抛出该类型，UI 据此中止播放并保留原档案。 */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/**
 * 对回放档案做严格结构/版本/校验和校验。
 * 任一问题都抛出 ReplayError，由调用方中止播放并保留原档案，绝不静默跳过。
 */
export function validateReplay(file: unknown): ReplayFile {
  if (!file || typeof file !== "object")
    throw new ReplayError("回放档案为空或结构损坏");
  const r = file as ReplayFile;
  if (r.kind !== "void-signal.replay")
    throw new ReplayError("不是受支持的行动回放档案");
  if (typeof r.rulesVersion !== "number" || typeof r.seed !== "number")
    throw new ReplayError("回放缺少规则版本或随机种子");
  if (r.rulesVersion !== RULES_VERSION)
    throw new ReplayError(
      `规则版本不支持（档案 v${r.rulesVersion} / 播放端 v${RULES_VERSION}），已中止播放`,
    );
  if (
    !Number.isFinite(r.seed) ||
    typeof r.ticks !== "number" ||
    r.ticks <= 0 ||
    typeof r.inputStream !== "string" ||
    !Array.isArray(r.upgrades) ||
    !r.summary
  )
    throw new ReplayError("回放字段缺失或损坏，已中止播放");
  const expected = checksum({ ...r, checksum: "" } as Omit<
    ReplayFile,
    "checksum"
  >);
  if (expected !== r.checksum)
    throw new ReplayError("回放校验和不匹配，档案可能已损坏，已中止播放");
  const frames = decodeStream(r.inputStream);
  if (frames.length !== r.ticks)
    throw new ReplayError(
      `输入帧数(${frames.length})与记录 tick 数(${r.ticks})不符，已中止播放`,
    );
  for (const u of r.upgrades) {
    if (
      !u ||
      typeof u.tick !== "number" ||
      !Array.isArray(u.choices) ||
      typeof u.chosen !== "string" ||
      !u.choices.includes(u.chosen)
    )
      throw new ReplayError("升级事件损坏，已中止播放");
  }
  return r;
}
