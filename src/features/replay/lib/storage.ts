import type { ReplayFile } from "../../../shared/types";
import { validateReplay, ReplayError } from "./codec";

const REPLAY_KEY = "neon-survivor.replays.v1";

type ReplayMap = Record<string, ReplayFile>;

/**
 * 回放与战绩分开存储、按 recordId 关联。
 * 读取时逐个校验：损坏/版本不支持的条目会被隔离，绝不影响原有战绩汇总。
 */
export function loadReplays(): ReplayMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(REPLAY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: ReplayMap = {};
    for (const [id, file] of Object.entries(parsed as ReplayMap)) {
      try {
        const valid = validateReplay(file);
        if (valid.recordId === id) result[id] = valid;
      } catch {
        /* 隔离损坏条目，保留原始字符串不覆盖，原战绩汇总不受影响。 */
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveReplay(file: ReplayFile): void {
  try {
    if (typeof window === "undefined") return;
    const valid = validateReplay(file);
    const all = loadReplaysRaw();
    all[valid.recordId] = valid;
    window.localStorage.setItem(REPLAY_KEY, JSON.stringify(all));
  } catch {
    /* 存储不可用不应中断行动本身。 */
  }
}

/** 读取原始映射（不做校验），用于写回时保留其它条目。 */
function loadReplaysRaw(): ReplayMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(REPLAY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as ReplayMap) : {};
  } catch {
    return {};
  }
}

export function getReplay(recordId: string): ReplayFile | null {
  const all = loadReplays();
  return all[recordId] ?? null;
}

/** 导出为可下载的 JSON 文件内容。 */
export function exportReplayJSON(file: ReplayFile): string {
  return JSON.stringify(validateReplay(file), null, 2);
}

/** 解析并严格校验导入的回放文本；不合法时抛出 ReplayError，不写入任何数据。 */
export function parseReplayJSON(text: string): ReplayFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReplayError("文件不是合法的 JSON，导入已取消");
  }
  return validateReplay(parsed);
}
