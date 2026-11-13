import { useRef, useState } from "react";
import { Play, Download, Upload, Film } from "lucide-react";
import type { ReplayFile, RunRecord } from "../../../shared/types";
import { formatTime } from "../../../shared/math";
import {
  exportReplayJSON,
  parseReplayJSON,
  ReplayError,
} from "../../replay";

export function HistoryPanel({
  records,
  replays,
  close,
  onPlay,
}: {
  records: RunRecord[];
  replays: Record<string, ReplayFile>;
  close: () => void;
  onPlay: (file: ReplayFile) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState<ReplayFile | null>(null);

  const download = (file: ReplayFile) => {
    const blob = new Blob([exportReplayJSON(file)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replay-${file.recordId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    setImportError(null);
    try {
      const text = await picked.text();
      setImported(parseReplayJSON(text));
    } catch (err) {
      setImported(null);
      setImportError(
        err instanceof ReplayError ? err.message : "导入失败，档案无法识别",
      );
    }
  };

  return (
    <div className="overlay">
      <div className="history-dialog">
        <button className="close" onClick={close}>
          关闭 ✕
        </button>
        <div className="eyebrow">FLIGHT RECORDER</div>
        <h2>行动档案</h2>
        <div className="history-toolbar">
          <button className="outline" onClick={() => fileInput.current?.click()}>
            <Upload size={14} /> 导入回放
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={onPickFile}
          />
        </div>
        {importError && <p className="replay-error">{importError}</p>}
        {imported && (
          <div className="history-row replay-imported">
            <span>
              <Film size={13} /> 已载入回放
            </span>
            <span className="mono">{imported.recordId}</span>
            <button
              className="link-btn"
              onClick={() => {
                onPlay(imported);
              }}
            >
              <Play size={13} /> 播放
            </button>
          </div>
        )}
        {!records.length ? (
          <p>尚无行动记录，完成一局后自动保存在此浏览器。</p>
        ) : (
          records.map((r) => {
            const replay = r.hasReplay ? replays[r.id] : undefined;
            return (
              <div className="history-row" key={r.id}>
                <span>{r.victory ? "撤离成功" : "信号中断"}</span>
                <span>{formatTime(r.duration)}</span>
                <span>波次 {r.wave}</span>
                <span>{r.kills} 击杀</span>
                {replay ? (
                  <span className="history-actions">
                    <button
                      className="link-btn"
                      onClick={() => onPlay(replay)}
                      title="播放行动回放"
                    >
                      <Play size={13} /> 回放
                    </button>
                    <button
                      className="link-btn"
                      onClick={() => download(replay)}
                      title="导出回放档案"
                    >
                      <Download size={13} /> 导出
                    </button>
                  </span>
                ) : (
                  <span className="muted no-replay" title="该档案录制于回放功能上线前或已丢失">
                    无回放 · 仅汇总
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
