import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  AlertTriangle,
  Download,
  Film,
} from "lucide-react";
import type { ReplayFile, ReplayUpgradeEvent } from "../../../shared/types";
import { TICK_DURATION } from "../../../shared/rules";
import { formatTime } from "../../../shared/math";
import { ReplayPlayer, ReplayError } from "../lib/player";
import { renderScene } from "../../combat/lib/renderScene";
import { WIDTH, HEIGHT } from "../../../shared/types";
import { UPGRADE_CATALOG } from "../../progression/model/catalog";
import { exportReplayJSON } from "../lib/storage";

/**
 * 行动回放查看器：用独立的确定性 ReplayPlayer 重放，不写入任何真实战绩。
 * 支持播放/暂停、逐帧前进/后退、拖动定位；升级点可点击跳转并恢复当时候选，
 * 损坏事件或版本不支持时中止播放并保留原档案，绝不静默跳过。
 */
export function ReplayViewer({
  file,
  close,
}: {
  file: ReplayFile;
  close: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speedRef = useRef(1);
  const [speed, setSpeedState] = useState(1);

  // 整个查看器只构建一次播放器；构造期的版本/校验错误转为中止视图。
  // 播放器实例与构造错误都放在 ref，避免在 hooks 之前条件返回破坏 hook 顺序。
  const playerRef = useRef<ReplayPlayer | null>(null);
  const constructError = useRef<string | null>(null);
  if (playerRef.current === null && constructError.current === null) {
    try {
      playerRef.current = new ReplayPlayer(file);
    } catch (err) {
      constructError.current = errorMessage(err);
    }
  }
  if (constructError.current !== null)
    return <AbortView message={constructError.current} close={close} />;
  // 走到这里说明构造未抛错，播放器必然存在。
  const player = playerRef.current as ReplayPlayer;

  const upgradeTicks = useMemo(
    () => Array.from(new Set(file.upgrades.map((u) => u.tick))),
    [file.upgrades],
  );

  const draw = () => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx) renderScene(ctx, player.doc);
  };

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      setPlaying(false);
      setError(errorMessage(err));
    }
  };

  // 播放循环：按倍速每帧推进若干固定步长，结果与逐帧单步完全一致。
  useEffect(() => {
    if (!playing || error) return;
    let raf = 0;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      let failed = false;
      try {
        const steps = speedRef.current;
        for (let i = 0; i < steps; i++) {
          if (player.isDone) {
            setPlaying(false);
            break;
          }
          player.step();
        }
        setTick(player.currentTick);
        if (player.isDone) setPlaying(false);
      } catch (err) {
        failed = true;
        setPlaying(false);
        setError(errorMessage(err));
      }
      // 出错或播放结束后停止调度，避免空转。
      if (!failed && player && !player.isDone) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, error]);

  useEffect(draw, [tick]);

  const stepFrame = (delta: number) => {
    setPlaying(false);
    safe(() => {
      if (delta > 0) {
        for (let i = 0; i < delta && !player.isDone; i++) player.step();
      } else {
        player.seek(Math.max(0, player.currentTick + delta));
      }
      setTick(player.currentTick);
    });
  };

  const onScrub = (value: number) => {
    setPlaying(false);
    safe(() => {
      player.seek(Number(value));
      setTick(player.currentTick);
    });
  };

  const jumpToUpgrade = (u: ReplayUpgradeEvent) => {
    setPlaying(false);
    safe(() => {
      player.seek(u.tick);
      setTick(player.currentTick);
    });
  };

  // 拖到升级点附近时，返回该 tick 的整组升级事件（同 tick 可能连升多级）。
  const currentUpgrade = (): ReplayUpgradeEvent[] => {
    const near = TICK_DURATION * 30; // 0.5 秒内视为“拖到升级附近”
    return file.upgrades.filter(
      (u) => Math.abs(u.tick - player.currentTick) * TICK_DURATION <= near,
    );
  };

  const setSpeed = (s: number) => {
    speedRef.current = s;
    setSpeedState(s);
  };

  const onExport = () => {
    try {
      const text = exportReplayJSON(file);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `replay-${file.recordId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (error) return <AbortView message={error} close={close} />;

  const up = currentUpgrade();
  const progress = player.length ? (tick / player.length) * 100 : 0;

  return (
    <div className="overlay">
      <div className="replay-dialog">
        <button className="close" onClick={close}>
          关闭 ✕
        </button>
        <div className="replay-head">
          <span className="eyebrow">
            <Film size={13} /> ACTION REPLAY
          </span>
          <h2>行动回放</h2>
          <small className="muted">
            规则 v{file.rulesVersion} · 种子 {file.seed} · {player.length} 帧 ·
            仅重放，不计入战绩
          </small>
        </div>

        <div className="replay-stage">
          <canvas
            ref={canvas}
            width={WIDTH}
            height={HEIGHT}
            aria-label="行动回放画面"
          />
          {up.length > 0 && (
            <div className="replay-upgrade-tag">
              <b>升级点 · 第 {up[0].tick} 帧{up.length > 1 ? ` · 连升 ${up.length} 级` : ""}</b>
              {up.map((event, idx) => (
                <div className="replay-choices" key={idx}>
                  {event.choices.map((id) => {
                    const def = UPGRADE_CATALOG.find((u) => u.id === id);
                    return (
                      <span
                        key={id}
                        className={id === event.chosen ? "chosen" : ""}
                      >
                        {def?.name ?? id}
                        {id === event.chosen ? " ✓" : ""}
                      </span>
                    );
                  })}
                </div>
              ))}
              <small>在途弹幕与候选已按当时状态恢复</small>
            </div>
          )}
        </div>

        <input
          className="replay-scrub"
          type="range"
          min={0}
          max={player.length}
          value={tick}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="回放进度定位"
        />
        <div className="replay-markers">
          {upgradeTicks.map((t) => (
            <button
              key={t}
              className="replay-marker"
              style={{ left: `${(t / player.length) * 100}%` }}
              title={`跳转到升级点（第 ${t} 帧）`}
              onClick={() => {
                const u = file.upgrades.find((x) => x.tick === t);
                if (u) jumpToUpgrade(u);
              }}
            />
          ))}
        </div>

        <div className="replay-controls">
          <div className="replay-buttons">
            <button onClick={() => stepFrame(-30)} title="后退 0.5 秒">
              <SkipBack size={16} />
            </button>
            <button onClick={() => stepFrame(-1)} title="上一帧">
              <SkipBack size={14} className="flip-none" />
              <span className="frame-step">帧</span>
            </button>
            <button
              className="replay-play"
              onClick={() =>
                safe(() => {
                  if (player.isDone) {
                    player.seek(0);
                    setTick(0);
                  }
                  setPlaying((p) => !p);
                })
              }
            >
              {playing ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <button onClick={() => stepFrame(1)} title="下一帧">
              <span className="frame-step">帧</span>
              <SkipForward size={14} />
            </button>
            <button onClick={() => stepFrame(30)} title="前进 0.5 秒">
              <SkipForward size={16} />
            </button>
          </div>
          <div className="replay-meta mono">
            {formatTime(tick * TICK_DURATION)} /{" "}
            {formatTime(player.length * TICK_DURATION)}
            <span className="replay-frame">
              帧 {tick}/{player.length}
            </span>
          </div>
          <div className="replay-speed">
            {[1, 2, 4].map((s) => (
              <button
                key={s}
                className={speed === s ? "active" : ""}
                onClick={() => setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
          <button className="outline replay-export" onClick={onExport}>
            <Download size={14} /> 导出
          </button>
        </div>
        <div className="replay-progress-line" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function AbortView({
  message,
  close,
}: {
  message: string;
  close: () => void;
}) {
  return (
    <div className="overlay">
      <div className="replay-dialog replay-abort">
        <button className="close" onClick={close}>
          关闭 ✕
        </button>
        <AlertTriangle size={34} className="abort-icon" />
        <div className="eyebrow">PLAYBACK ABORTED</div>
        <h2>回放已中止</h2>
        <p>{message}</p>
        <small className="muted">
          原始档案与战绩汇总保持不变，未做任何静默跳过或改写。
        </small>
        <button className="primary" onClick={close}>
          返回档案
        </button>
      </div>
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ReplayError) return err.message;
  if (err instanceof Error) return err.message;
  return "发生未知错误，回放已中止";
}
