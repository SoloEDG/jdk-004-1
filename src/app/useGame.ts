import { useEffect, useRef, useState } from "react";
import { createRun } from "../shared/createRun";
import type { Input } from "../shared/types";
import { simulate } from "./simulate";
import { chooseUpgrade } from "../features/progression";
import { loadRecords, saveRecords } from "../features/results";
import { InputRecorder } from "../features/replay/lib/recorder";
import { saveReplay } from "../features/replay/lib/storage";

export function useGame() {
  const game = useRef(createRun(204004, loadRecords()));
  const input = useRef<Input>({
    x: 0,
    y: 0,
    aim: { x: 500, y: 0 },
    firing: false,
  });
  const keys = useRef(new Set<string>());
  // 实时行动的输入录制器；回放战场不会创建录制器。
  const recorder = useRef<InputRecorder | null>(
    new InputRecorder(game.current.recordId!),
  );
  const [, render] = useState(0);

  // 行动结束时把录制结果与战绩一起持久化（仅实时行动，回放不触发）。
  const finalizeIfEnded = () => {
    const d = game.current;
    if (d.phase !== "ended" || d.replay || !recorder.current) return;
    const current = recorder.current;
    try {
      const replay = current.build(d);
      saveReplay(replay);
    } catch {
      /* 构建失败不阻断结算；该档案将缺少回放，仅展示汇总。 */
    }
    recorder.current = null;
  };

  useEffect(() => {
    let raf = 0,
      last = 0,
      acc = 0,
      paint = 0;
    const tick = (now: number) => {
      const elapsed = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      const d = game.current;
      input.current.x =
        Number(keys.current.has("d") || keys.current.has("arrowright")) -
        Number(keys.current.has("a") || keys.current.has("arrowleft"));
      input.current.y =
        Number(keys.current.has("s") || keys.current.has("arrowdown")) -
        Number(keys.current.has("w") || keys.current.has("arrowup"));
      if (d.phase === "playing") {
        acc += elapsed;
        while (acc >= 1 / 60) {
          // 先记录该固定步长使用的输入，再推进模拟，保证录制与实际驱动完全一致。
          if (recorder.current && !d.replay)
            recorder.current.recordTick(input.current);
          simulate(d, input.current, 1 / 60);
          // 升级在 simulate 内部触发后由玩家异步选择，实际选择在 choose() 中记录。
          acc -= 1 / 60;
          if (d.phase !== "playing") {
            acc = 0;
            break;
          }
        }
      } else acc = 0;
      finalizeIfEnded();
      if (now - paint > 32) {
        render((n) => n + 1);
        paint = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const pause = () => {
      if (game.current.phase === "playing") game.current.phase = "paused";
      keys.current.clear();
      input.current.firing = false;
    };
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k))
        e.preventDefault();
      keys.current.add(k);
      if ((k === "escape" || k === "p") && !e.repeat) {
        const d = game.current;
        if (d.phase === "playing") d.phase = "paused";
        else if (d.phase === "paused") d.phase = "playing";
      }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const hidden = () => {
      if (document.hidden) pause();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  return {
    game,
    input,
    start: () => {
      game.current.phase = "playing";
    },
    toggle: () => {
      const d = game.current;
      if (d.phase === "playing") d.phase = "paused";
      else if (d.phase === "paused") d.phase = "playing";
    },
    choose: (id: string) => {
      const d = game.current;
      if (d.phase === "upgrade" && recorder.current && !d.replay) {
        // 记录升级发生 tick、当时候选与玩家选择，回放时无随机地恢复面板。
        recorder.current.recordUpgrade(
          recorder.current.getTick(),
          d.choices,
          id,
        );
      }
      chooseUpgrade(d, id);
    },
    restart: () => {
      saveRecords(game.current.records);
      const next = createRun(204004, game.current.records);
      game.current = next;
      recorder.current = next.recordId
        ? new InputRecorder(next.recordId)
        : null;
      keys.current.clear();
      game.current.phase = "playing";
    },
  };
}
