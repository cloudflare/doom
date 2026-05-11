import { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// useDownloadProgress
//
// Aggregates per-file PreloadProgress events emitted by bootDoom into a
// single combined view. Returns:
//   - progress:     keyed by virtual-FS filename, the latest event per file
//   - onProgress:   the callback to hand to bootDoom
//   - totalPercent: combined loaded/total ratio across all known files (0..100)
//   - allDone:      true once every expected file has reported done=true.
//                   If `expected` is omitted the hook falls back to "every
//                   file I've observed so far is done", which is correct
//                   only when one file is preloaded — see the parallel
//                   preload note below.
//   - hasTotals:    true if at least one file has reported a non-zero total
//                   (used to switch between a determinate and indeterminate
//                   bar)
//
// Why `expected` matters: bootDoom triggers multiple preloads in parallel
// (the WAD and default.cfg). The smaller file (default.cfg) finishes and
// emits `done: true` long before the larger file emits its FIRST event.
// Without a known expected set, the hook briefly sees one file in `progress`
// that is already done and reports `allDone: true`, causing the overlay to
// flicker off and back on. Declaring the expected files makes the batch
// stay "in progress" until the slower file has reported in and finished.
// ---------------------------------------------------------------------------
type ProgressMap = Record<string, any>;

export const useDownloadProgress = (expected?: readonly string[]) => {
  const [progress, setProgress] = useState<ProgressMap>({});

  const onProgress = useCallback((p:any) => {
    setProgress((prev) => ({ ...prev, [p.file]: p }));
  }, []);

  // Reset progress state when the expected set changes (e.g. switching
  // IWAD between sessions). Without this, stale `done:true` entries from a
  // previous boot would make `allDone` immediately true. Keyed off the
  // joined string so we don't churn on identity-only changes to the array.
  const expectedKey = expected ? expected.join("|") : "";
  useEffect(() => {
    setProgress({});
  }, [expectedKey]);

  const { totalPercent, allDone, hasTotals, totalLoaded, totalTotal } =
    useMemo(() => {
      const entries = Object.values(progress);
      if (entries.length === 0) {
        return {
          totalPercent: 0,
          allDone: false,
          hasTotals: false,
          totalLoaded: 0,
          totalTotal: 0,
        };
      }
      let loadedSum = 0;
      let totalSum = 0;
      let anyTotal = false;
      let everyObservedDone = true;
      for (const e of entries) {
        loadedSum += e.loaded;
        totalSum += e.total;
        if (e.total > 0) anyTotal = true;
        if (!e.done) everyObservedDone = false;
      }
      // If the caller declared which files to expect, the batch isn't
      // "done" until each expected file has been observed AND marked done.
      // Fall back to the old observed-only heuristic when expected is
      // unspecified.
      const allExpectedDone =
        !expected || expected.length === 0
          ? everyObservedDone
          : expected.every((f) => progress[f]?.done === true);
      const pct =
        totalSum > 0 ? Math.min(100, (loadedSum / totalSum) * 100) : 0;
      return {
        totalPercent: pct,
        allDone: allExpectedDone,
        hasTotals: anyTotal,
        totalLoaded: loadedSum,
        totalTotal: totalSum,
      };
    }, [progress, expected]);

  return {
    progress,
    onProgress,
    totalPercent,
    allDone,
    hasTotals,
    totalLoaded,
    totalTotal,
  };
};

const formatMB = (bytes: number): string => (bytes / 1048576).toFixed(1);

type DownloadProgressProps = {
  iwadLabel: string;
  totalPercent: number;
  hasTotals: boolean;
  totalLoaded: number;
  totalTotal: number;
};

export const DownloadProgress = ({
  iwadLabel,
  totalPercent,
  hasTotals,
  totalLoaded,
  totalTotal,
}: DownloadProgressProps) => {
  const widthPct = hasTotals ? totalPercent : 100;
  // We render this as an absolutely-positioned overlay on top of the canvas
  // (which itself is `position: absolute; inset: 0` inside #monitorscreen,
  // see styles.css:143-149). The canvas MUST stay laid out at its full size
  // underneath, because chocolate-doom's SDL_CreateWindow reads the canvas's
  // computed dimensions during boot — if it's `display: none` at that point
  // SDL captures a 0x0 framebuffer and never paints anything visible after
  // we reveal it (audio keeps working because it's unrelated to canvas
  // layout).
  //
  // Indeterminate bar: full-width track in muted colour while we wait for
  // Content-Length to tell us where the finish line is.
  return (
    <div
      id="text"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        background: "rgba(0, 0, 0, 0.85)",
        textAlign: "center",
      }}
    >
      <h1 className="vspace">Loading {iwadLabel}…</h1>
      <div
        style={{
          width: "80%",
          maxWidth: 480,
          margin: "1em auto",
          border: "2px solid currentColor",
          height: 24,
          padding: 2,
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            width: `${widthPct}%`,
            height: "100%",
            background: "currentColor",
            opacity: hasTotals ? 1 : 0.35,
            transition: "width 120ms linear",
          }}
        />
      </div>
      <h1>
        {hasTotals
          ? `${formatMB(totalLoaded)} MB / ${formatMB(totalTotal)} MB (${Math.floor(totalPercent)}%)`
          : `${formatMB(totalLoaded)} MB downloaded`}
      </h1>
    </div>
  );
};

