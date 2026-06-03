import { useEffect, useState } from "react";
import { Prefill } from "../App";
import { ImageRow, MODELS, QueueTask } from "../api";
import { useI18n } from "../i18n";
import ReferenceTray from "../components/ReferenceTray";
import OptionBar from "../components/OptionBar";
import QueueList from "../components/QueueList";

export default function Generate({
  tray,
  prefill,
  consumePrefill,
  addManyToTray,
  removeFromTray,
  moveInTray,
  keyConfigured,
  queue,
  enqueue,
  removeTask,
  clearDone,
}: {
  tray: ImageRow[];
  prefill: Prefill | null;
  consumePrefill: () => void;
  addManyToTray: (imgs: ImageRow[]) => void;
  removeFromTray: (id: number) => void;
  moveInTray: (from: number, to: number) => void;
  keyConfigured: boolean;
  queue: QueueTask[];
  enqueue: (task: Omit<QueueTask, "id" | "status">) => void;
  removeTask: (id: string) => void;
  clearDone: () => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [resolution, setResolution] = useState("1K");
  const [format, setFormat] = useState("image/jpeg");

  // Apply a "reuse" prefill coming from the History tab.
  useEffect(() => {
    if (prefill) {
      setPrompt(prefill.prompt);
      setModel(prefill.model);
      if (prefill.aspectRatio) setAspectRatio(prefill.aspectRatio);
      if (prefill.resolution) setResolution(prefill.resolution);
      consumePrefill();
    }
  }, [prefill, consumePrefill]);

  const isPro = MODELS.find((m) => m.id === model)?.pro ?? false;

  // Submit: snapshot the composer into the queue. Keep the prompt in place so
  // repeated generations and small edits don't require retyping it.
  const submit = () => {
    enqueue({
      prompt,
      model,
      aspectRatio,
      resolution: isPro ? resolution : null,
      format,
      inputs: [...tray],
    });
  };

  return (
    <div>
      <div className="panel">
        <ReferenceTray
          tray={tray}
          onAdd={addManyToTray}
          onRemove={removeFromTray}
          onMove={moveInTray}
        />
        <div style={{ marginTop: 16 }}>
          <label>{t("prompt")}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("prompt_placeholder")}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <OptionBar
            model={model}
            setModel={setModel}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            resolution={resolution}
            setResolution={setResolution}
            format={format}
            setFormat={setFormat}
          />
        </div>
        <div style={{ marginTop: 18, display: "flex", gap: 12, alignItems: "center" }}>
          <button
            className="primary"
            onClick={submit}
            disabled={!keyConfigured || (!prompt.trim() && tray.length === 0)}
          >
            {t("generate")}
          </button>
          <span className="muted small">
            {t("ref_count", { n: tray.length })}
            {!keyConfigured && t("need_key_inline")}
          </span>
        </div>
      </div>

      <QueueList
        queue={queue}
        onRemove={removeTask}
        onClearDone={clearDone}
        onUseAsRef={(img) => addManyToTray([img])}
      />
    </div>
  );
}
