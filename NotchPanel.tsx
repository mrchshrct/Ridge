import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Transition } from "framer-motion";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  FolderOpen,
  Music2,
  LockKeyhole,
  Move,
  Pause,
  Play,
  Power,
  RotateCcw,
  Settings,
  SkipBack,
  SkipForward,
  Trash2,
  UnlockKeyhole,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* -------------------------------------------------------------------------- */
/* Types & constants                                                          */
/* -------------------------------------------------------------------------- */

type TabId = "media" | "clipboard" | "shelf" | "calendar" | "settings";
type MediaAction = "toggle" | "next" | "previous";
type FileDragEvent = { phase: "enter" | "over" | "drop" | "leave"; paths: string[] };
type NativeFileDragEvent = {
  result: "Dropped" | "Cancel";
  cursorPos: { x: number; y: number };
};

/** Mirrors `MediaInfo` in media.rs (camelCase over the wire). */
interface MediaInfo {
  hasSession: boolean;
  title: string;
  artist: string;
  isPlaying: boolean;
  sourceApp: string;
  positionMs: number;
  durationMs: number;
}

// Keep in sync with COLLAPSED / EXPANDED in lib.rs.
const COLLAPSED = { width: 320, height: 28, radius: 14 } as const;
const EXPANDED = { width: 620, height: 260, radius: 28 } as const;

/** Grace period so a brief slip of the cursor doesn't collapse the panel. */
const COLLAPSE_DELAY_MS = 140;

const PANEL_TRANSITION: Transition = {
  type: "tween",
  duration: 0.55,
  ease: [0.22, 1, 0.36, 1],
};
const COLLAPSE_TRANSITION: Transition = {
  type: "tween",
  duration: 0.62,
  ease: [0.22, 1, 0.36, 1],
};
const INSTANT: Transition = { duration: 0 };

const TABS: { id: TabId; label: string; Icon: LucideIcon }[] = [
  { id: "media", label: "Media", Icon: Music2 },
  { id: "clipboard", label: "Clipboard", Icon: ClipboardList },
  { id: "shelf", label: "Shelf", Icon: FolderOpen },
  { id: "calendar", label: "Calendar", Icon: CalendarDays },
  { id: "settings", label: "Settings", Icon: Settings },
];

function droppedFilePaths(files: FileList): string[] {
  return Array.from(files).flatMap((file) => {
    if ("path" in file && typeof file.path === "string" && file.path.length > 0) {
      return [file.path];
    }
    return [];
  });
}

function createGenericDragPreview(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a file drag preview");

  context.fillStyle = "#18181b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#a1a1aa";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(20, 12);
  context.lineTo(37, 12);
  context.lineTo(46, 21);
  context.lineTo(46, 51);
  context.lineTo(20, 51);
  context.closePath();
  context.stroke();
  context.beginPath();
  context.moveTo(36, 13);
  context.lineTo(36, 22);
  context.lineTo(45, 22);
  context.stroke();
  return canvas.toDataURL("image/png");
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* -------------------------------------------------------------------------- */

function useMedia(intervalMs: number) {
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [coverArt, setCoverArt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMedia(await invoke<MediaInfo>("get_current_media"));
    } catch (error) {
      console.error("get_current_media failed:", error);
      setMedia(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(id);
  }, [refresh, intervalMs]);

  const trackKey =
    media?.hasSession ? JSON.stringify([media.sourceApp, media.title, media.artist]) : "";

  useEffect(() => {
    setCoverArt(null);
    if (!trackKey) return;

    let cancelled = false;
    invoke<string | null>("get_current_media_art")
      .then((art) => {
        if (!cancelled) setCoverArt(art);
      })
      .catch((error) => {
        console.error("get_current_media_art failed:", error);
        if (!cancelled) setCoverArt(null);
      });

    return () => {
      cancelled = true;
    };
  }, [trackKey]);

  return { media, coverArt, refresh };
}

function useClipboardHistory() {
  const [items, setItems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<string[]>("get_clipboard_history");
      setItems((current) =>
        current.length === next.length && current.every((item, index) => item === next[index])
          ? current
          : next,
      );
      setError(null);
    } catch (error) {
      console.error("get_clipboard_history failed:", error);
      setError("Clipboard history is temporarily unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(id);
  }, [refresh]);

  const clear = useCallback(async () => {
    try {
      await invoke("clear_clipboard_history");
      setItems([]);
      setError(null);
    } catch (error) {
      console.error("clear_clipboard_history failed:", error);
      setError("Could not clear clipboard history");
    }
  }, []);

  return { items, clear, error };
}

function useUpdater() {
  const [version, setVersion] = useState("0.1.0");
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("Update status is not checked yet.");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const availableUpdateRef = useRef<Update | null>(null);

  const checkForUpdates = useCallback(async () => {
    setIsChecking(true);
    setUpdateStatus("Checking for updates...");
    try {
      const update = await check();
      const previousUpdate = availableUpdateRef.current;
      availableUpdateRef.current = update;
      setAvailableUpdate(update);
      if (previousUpdate && previousUpdate !== update) {
        void previousUpdate.close().catch((error: unknown) => {
          console.error("Could not release the previous update:", error);
        });
      }
      setUpdateStatus(
        update ? `Version ${update.version} is available.` : "Ridge is up to date.",
      );
      return update;
    } catch (error) {
      console.error("Update check failed:", error);
      const previousUpdate = availableUpdateRef.current;
      availableUpdateRef.current = null;
      setAvailableUpdate(null);
      if (previousUpdate) {
        void previousUpdate.close().catch((closeError: unknown) => {
          console.error("Could not release the previous update:", closeError);
        });
      }
      setUpdateStatus("Could not check for updates. Check your internet connection.");
      return null;
    } finally {
      setIsChecking(false);
    }
  }, []);

  const installUpdate = useCallback(async (update: Update) => {
    if (!window.confirm(`Install Ridge ${update.version} now? Ridge will close during installation.`)) {
      return;
    }

    setIsInstalling(true);
    setUpdateStatus(`Downloading Ridge ${update.version}...`);
    try {
      await update.downloadAndInstall();
      setUpdateStatus("Update installed. Ridge is restarting...");
    } catch (error) {
      console.error("Update installation failed:", error);
      setUpdateStatus("Could not install the update. Please try again.");
      setIsInstalling(false);
    }
  }, []);

  const toggleAutoUpdate = useCallback((enabled: boolean) => {
    try {
      window.localStorage.setItem("ridge.autoUpdate", String(enabled));
      setAutoUpdate(enabled);
      setUpdateStatus(
        enabled ? "Automatic update checks are enabled." : "Automatic update checks are disabled.",
      );
    } catch (error) {
      console.error("Could not save automatic update preference:", error);
      setUpdateStatus("Could not save the automatic update setting.");
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    getVersion()
      .then((appVersion) => {
        if (!disposed) setVersion(appVersion);
      })
      .catch((error: unknown) => {
        console.error("Could not read the app version:", error);
        if (!disposed) setUpdateStatus("Could not read the installed app version.");
      });

    try {
      setAutoUpdate(window.localStorage.getItem("ridge.autoUpdate") === "true");
    } catch (error) {
      console.error("Could not load automatic update preference:", error);
      setUpdateStatus("Could not load the automatic update setting.");
    } finally {
      setPreferenceLoaded(true);
    }

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!preferenceLoaded || !autoUpdate) return;

    let disposed = false;
    const checkAndPrompt = async () => {
      const update = await checkForUpdates();
      if (update && !disposed) await installUpdate(update);
    };
    const initialCheck = window.setTimeout(() => void checkAndPrompt(), 1200);
    const dailyCheck = window.setInterval(
      () => void checkAndPrompt(),
      24 * 60 * 60 * 1000,
    );

    return () => {
      disposed = true;
      window.clearTimeout(initialCheck);
      window.clearInterval(dailyCheck);
    };
  }, [autoUpdate, checkForUpdates, installUpdate, preferenceLoaded]);

  return {
    version,
    autoUpdate,
    isChecking,
    isInstalling,
    updateStatus,
    availableUpdate,
    checkForUpdates,
    installUpdate,
    toggleAutoUpdate,
  };
}

/* -------------------------------------------------------------------------- */
/* Main component                                                             */
/* -------------------------------------------------------------------------- */

export default function NotchPanel() {
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabId>("media");
  const [files, setFiles] = useState<string[]>([]);
  const [dismissedScreenshots, setDismissedScreenshots] = useState<string[]>([]);
  const [shelfNotice, setShelfNotice] = useState("");
  const [panelLocked, setPanelLocked] = useState(true);
  const [settingsError, setSettingsError] = useState("");
  const clipboard = useClipboardHistory();
  const updater = useUpdater();

  // Poll quickly while open, lazily while collapsed (the bar shows the track).
  const { media, coverArt, refresh } = useMedia(expanded ? 1000 : 4000);

  const hovering = useRef(false);
  const draggingFiles = useRef(false);
  const draggingFilesOut = useRef(false);
  const draggingPanel = useRef(false);
  const nativeDragActive = useRef(false);
  const htmlDragDepth = useRef(0);
  const dragExpansionRequested = useRef(false);
  const panelWasExpanded = useRef(false);
  const collapseTimer = useRef<number | undefined>(undefined);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  useEffect(() => {
    let disposed = false;
    invoke<boolean>("get_panel_locked")
      .then((locked) => {
        if (!disposed) setPanelLocked(locked);
      })
      .catch((error: unknown) => {
        console.error("get_panel_locked failed:", error);
        if (!disposed) setSettingsError("Could not load panel settings");
      });
    return () => {
      disposed = true;
    };
  }, []);

  /** Grow the native window first, then animate the panel into it. */
  const open = useCallback(async () => {
    window.clearTimeout(collapseTimer.current);
    try {
      await invoke("set_panel_expanded", { expanded: true });
    } catch (error) {
      console.error("set_panel_expanded(true) failed:", error);
    }
    if (
      hovering.current ||
      draggingFiles.current ||
      draggingFilesOut.current ||
      draggingPanel.current
    ) {
      panelWasExpanded.current = true;
      setExpanded(true);
    }
  }, []);

  /** Animate the panel away first, then shrink the native window. */
  const close = useCallback(() => {
    window.clearTimeout(collapseTimer.current);
    collapseTimer.current = window.setTimeout(() => {
      if (
        hovering.current ||
        draggingFiles.current ||
        draggingFilesOut.current ||
        draggingPanel.current
      ) return;
      setExpanded(false);
    }, COLLAPSE_DELAY_MS);
  }, []);

  useEffect(() => {
    const finishPanelDrag = () => {
      if (!draggingPanel.current) return;
      draggingPanel.current = false;
      if (!hovering.current) close();
    };
    window.addEventListener("pointerup", finishPanelDrag);
    return () => window.removeEventListener("pointerup", finishPanelDrag);
  }, [close]);

  const handlePanelAnimationComplete = useCallback(() => {
    if (
      expanded ||
      draggingFiles.current ||
      draggingFilesOut.current ||
      draggingPanel.current ||
      !panelWasExpanded.current ||
      hovering.current
    ) return;
    panelWasExpanded.current = false;
    invoke("set_panel_expanded", { expanded: false }).catch((error) =>
      console.error("set_panel_expanded(false) failed:", error),
    );
  }, [expanded]);

  const handleEnter = useCallback(() => {
    hovering.current = true;
    void open();
  }, [open]);

  const handleLeave = useCallback(() => {
    hovering.current = false;
    if (draggingFiles.current || draggingFilesOut.current || draggingPanel.current) return;
    close();
  }, [close]);

  const addFiles = useCallback((paths: string[]) => {
    setFiles((current) => {
      const next = Array.from(new Set([...current, ...paths]));
      return next.length === current.length ? current : next;
    });
  }, []);

  const removeShelfFile = useCallback(async (path: string) => {
    setFiles((current) => current.filter((item) => item !== path));
    try {
      const deleted = await invoke<boolean>("delete_managed_screenshot", { path });
      setShelfNotice(deleted ? "Screenshot deleted from disk" : "Removed from shelf");
    } catch (error) {
      console.error("delete_managed_screenshot failed:", error);
      setFiles((current) => (current.includes(path) ? current : [...current, path]));
      setShelfNotice("Could not delete the screenshot; it was restored to the shelf");
    }
  }, []);

  const removeMissingShelfFiles = useCallback((missingPaths: string[]) => {
    const missing = new Set(missingPaths);
    setFiles((current) => current.filter((path) => !missing.has(path)));
    setShelfNotice(
      missingPaths.length === 1
        ? "A file removed outside Ridge was cleared from the shelf"
        : `${missingPaths.length} files removed outside Ridge were cleared from the shelf`,
    );
  }, []);

  const beginFileDragOut = useCallback(() => {
    window.clearTimeout(collapseTimer.current);
    draggingFilesOut.current = true;
  }, []);

  const finishFileDragOut = useCallback(() => {
    draggingFilesOut.current = false;
    if (!hovering.current && !draggingFiles.current) close();
  }, [close]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<string>("screenshot-captured", ({ payload }) => {
      addFiles([payload]);
      setTab("shelf");
      setShelfNotice("Screenshot added from the Screenshots folder");
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error("screenshot-captured listener failed:", error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addFiles]);

  useEffect(() => {
    const handlePasteShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== "v") return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.closest("[data-allow-text-paste]"))
      ) {
        return;
      }

      event.preventDefault();
      setTab("shelf");
      hovering.current = true;
      void (async () => {
        try {
          await invoke("set_panel_expanded", { expanded: true });
          setExpanded(true);
          const paths = await invoke<string[]>("paste_clipboard_items");
          if (paths.length > 0) {
            addFiles(paths);
            setShelfNotice(paths.length === 1 ? "Pasted item added to shelf" : `${paths.length} items added to shelf`);
          } else {
            setShelfNotice("Clipboard has no image or files");
          }
        } catch (error) {
          console.error("paste_clipboard_items failed:", error);
          setShelfNotice("Could not paste clipboard items");
        }
      })();
    };

    window.addEventListener("keydown", handlePasteShortcut);
    return () => window.removeEventListener("keydown", handlePasteShortcut);
  }, [addFiles]);

  const releaseFileDrag = useCallback(() => {
    if (nativeDragActive.current || htmlDragDepth.current > 0) return;
    draggingFiles.current = false;
    dragExpansionRequested.current = false;
    setIsDraggingFiles(false);
    hovering.current = false;
    close();
  }, [close]);

  const handleFileDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      htmlDragDepth.current += 1;
      draggingFiles.current = true;
      setIsDraggingFiles(true);
      setTab("shelf");
      if (!dragExpansionRequested.current) {
        dragExpansionRequested.current = true;
        void open();
      }
    },
    [open],
  );

  const handleFileDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (htmlDragDepth.current === 0 && !nativeDragActive.current) {
      htmlDragDepth.current = 1;
    }
    if (!draggingFiles.current) {
      draggingFiles.current = true;
      setIsDraggingFiles(true);
      setTab("shelf");
    }
    if (!dragExpansionRequested.current) {
      dragExpansionRequested.current = true;
      void open();
    }
  }, [open]);

  const handleFileDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    htmlDragDepth.current = Math.max(0, htmlDragDepth.current - 1);
    releaseFileDrag();
  }, [releaseFileDrag]);

  const handleFileDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files") && event.dataTransfer.files.length === 0) {
        return;
      }
      const handledByShelf = event.defaultPrevented;
      event.preventDefault();
      if (!handledByShelf) {
        addFiles(droppedFilePaths(event.dataTransfer.files));
      }
      htmlDragDepth.current = 0;
      if (nativeDragActive.current) return;
      draggingFiles.current = false;
      dragExpansionRequested.current = false;
      setIsDraggingFiles(false);
      setTab("shelf");
      hovering.current = true;
      void open();
    },
    [addFiles, open],
  );

  useEffect(
    () => () => {
      window.clearTimeout(collapseTimer.current);
    },
    [],
  );

  // The backend expands the native window before broadcasting the OS drag event.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<FileDragEvent>("ridge-file-drag", ({ payload }) => {
      if (payload.phase === "enter" || payload.phase === "over") {
        htmlDragDepth.current = 0;
        nativeDragActive.current = true;
        draggingFiles.current = true;
        dragExpansionRequested.current = true;
        setIsDraggingFiles(true);
        setTab("shelf");
        setExpanded(true);
      } else if (payload.phase === "leave") {
        htmlDragDepth.current = 0;
        nativeDragActive.current = false;
        releaseFileDrag();
      } else {
        nativeDragActive.current = false;
        htmlDragDepth.current = 0;
        draggingFiles.current = false;
        dragExpansionRequested.current = false;
        setIsDraggingFiles(false);
        setTab("shelf");
        addFiles(payload.paths);
        hovering.current = true;
        setExpanded(true);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error("drag-drop listener failed:", error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addFiles, releaseFileDrag]);

  const control = useCallback(
    async (action: MediaAction) => {
      try {
        await invoke("media_control", { action });
      } catch (error) {
        console.error("media_control failed:", error);
      }
      window.setTimeout(() => void refresh(), 250);
    },
    [refresh],
  );

  const togglePanelLock = useCallback(async () => {
    try {
      const locked = await invoke<boolean>("set_panel_locked", {
        locked: !panelLocked,
      });
      setPanelLocked(locked);
      setSettingsError("");
    } catch (error) {
      console.error("set_panel_locked failed:", error);
      setSettingsError("Could not update the position lock");
    }
  }, [panelLocked]);

  const beginPanelMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (panelLocked) return;
      draggingPanel.current = true;
      invoke("start_panel_drag").catch((error: unknown) => {
        console.error("start_panel_drag failed:", error);
        draggingPanel.current = false;
        setSettingsError("Could not start moving the panel");
      });
    },
    [panelLocked],
  );

  const quitApp = useCallback(async () => {
    try {
      await invoke("quit_app");
    } catch (error) {
      console.error("quit_app failed:", error);
      setSettingsError("Could not close Ridge");
    }
  }, []);

  const resetPanelPosition = useCallback(async () => {
    try {
      await invoke("reset_panel_position");
      setSettingsError("");
    } catch (error) {
      console.error("reset_panel_position failed:", error);
      setSettingsError("Could not reset the panel position");
    }
  }, []);

  const transition = reduceMotion
    ? INSTANT
    : expanded
      ? PANEL_TRANSITION
      : COLLAPSE_TRANSITION;
  const compactLabel =
    media?.hasSession && media.isPlaying
      ? [media.title, media.artist].filter(Boolean).join(" – ")
      : "";

  return (
    <div
      className="flex h-screen w-screen items-start justify-center font-sans"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <motion.div
        role="region"
        aria-label="Ridge"
        className="relative overflow-hidden border-x border-b border-white/10 bg-[#08090b] text-zinc-100"
        initial={false}
        animate={{
          width: expanded ? EXPANDED.width : COLLAPSED.width,
          height: expanded ? EXPANDED.height : COLLAPSED.height,
          borderBottomLeftRadius: expanded ? EXPANDED.radius : COLLAPSED.radius,
          borderBottomRightRadius: expanded ? EXPANDED.radius : COLLAPSED.radius,
        }}
        transition={transition}
        onAnimationComplete={handlePanelAnimationComplete}
      >
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              key="expanded"
              className="absolute inset-0 flex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: reduceMotion ? 0 : 0.08, duration: 0.18 } }}
              exit={{
                opacity: 0,
                y: -4,
                transition: { duration: reduceMotion ? 0 : 0.24, ease: "easeOut" },
              }}
            >
              <TabBar active={tab} onChange={setTab} />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-4 py-3">
                <header className="flex h-5 shrink-0 items-center justify-between px-1">
                  <h1 className="text-[11px] font-semibold tracking-[0.12em] text-zinc-500">
                    {TABS.find(({ id }) => id === tab)?.label}
                  </h1>
                  {tab === "media" && media?.hasSession && (
                    <MediaSourceStatus media={media} />
                  )}
                </header>
                <div className="min-h-0 flex-1">
                  {tab === "media" && <MediaTab media={media} coverArt={coverArt} onControl={control} />}
                  {tab === "clipboard" && (
                    <ClipboardTab
                      items={clipboard.items}
                      error={clipboard.error}
                      onClear={clipboard.clear}
                    />
                  )}
                  {tab === "shelf" && (
                    <FileShelf
                      files={files}
                      isDragging={isDraggingFiles}
                      status={shelfNotice}
                      onFilesDropped={addFiles}
                      onStatusChange={setShelfNotice}
                      onFileDragStart={beginFileDragOut}
                      onFileDragEnd={finishFileDragOut}
                      onMissingFiles={removeMissingShelfFiles}
                      dismissedScreenshots={dismissedScreenshots}
                      onDismissScreenshots={(paths) =>
                        setDismissedScreenshots((current) =>
                          Array.from(new Set([...current, ...paths])),
                        )
                      }
                      onRemove={removeShelfFile}
                      onClear={() => {
                        setFiles([]);
                        setShelfNotice("");
                      }}
                    />
                  )}
                  {tab === "calendar" && <CalendarTab />}
                  {tab === "settings" && (
                    <SettingsTab
                      locked={panelLocked}
                      error={settingsError}
                      version={updater.version}
                      autoUpdate={updater.autoUpdate}
                      isChecking={updater.isChecking}
                      isInstalling={updater.isInstalling}
                      updateStatus={updater.updateStatus}
                      availableUpdate={updater.availableUpdate}
                      onToggleLock={() => void togglePanelLock()}
                      onMove={beginPanelMove}
                      onResetPosition={() => void resetPanelPosition()}
                      onQuit={() => void quitApp()}
                      onToggleAutoUpdate={updater.toggleAutoUpdate}
                      onCheckUpdates={() => void updater.checkForUpdates()}
                      onInstallUpdate={(update) => void updater.installUpdate(update)}
                    />
                  )}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="compact"
              className="absolute inset-0 flex items-center justify-center gap-2 px-5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: reduceMotion ? 0 : 0.18, duration: 0.22 } }}
              exit={{ opacity: 0, transition: { duration: 0.06 } }}
            >
              {compactLabel ? (
                <>
                  <Equalizer active height={10} />
                  <span className="truncate text-[11px] text-zinc-300">{compactLabel}</span>
                </>
              ) : (
                <span className="h-[3px] w-10 rounded-full bg-white/20" />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tab bar                                                                    */
/* -------------------------------------------------------------------------- */

function TabBar({
  active,
  onChange,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const [tooltip, setTooltip] = useState<{ id: TabId; top: number } | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    },
    [],
  );

  const showTooltip = (id: TabId, button: HTMLButtonElement) => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    const top = button.offsetTop + button.offsetHeight / 2;
    tooltipTimer.current = setTimeout(() => setTooltip({ id, top }), 450);
  };
  const hideTooltip = () => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    tooltipTimer.current = null;
    setTooltip(null);
  };

  return (
    <div
      role="tablist"
      aria-label="Sections"
      aria-orientation="vertical"
      className="relative flex w-[52px] shrink-0 flex-col items-center gap-2 border-r border-white/10 pt-8"
    >
      {TABS.map(({ id, label, Icon }) => {
        const selected = id === active;
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-label={label}
            onClick={() => onChange(id)}
            onMouseEnter={(event) => showTooltip(id, event.currentTarget)}
            onMouseLeave={hideTooltip}
            onFocus={(event) => showTooltip(id, event.currentTarget)}
            onBlur={hideTooltip}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-300/70 ${
              selected
                ? "bg-white/10 text-white"
                : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            }`}
          >
            <Icon size={17} aria-hidden />
          </button>
        );
      })}
      {tooltip && (
        <span
          aria-hidden="true"
          style={{ top: tooltip.top }}
          className="pointer-events-none absolute left-[calc(100%+8px)] z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-white/10 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-100 shadow-xl"
        >
          {TABS.find(({ id }) => id === tooltip.id)?.label}
        </span>
      )}
    </div>
  );
}

function MediaSourceStatus({ media }: { media: MediaInfo }) {
  return (
    <div
      title={media.sourceApp}
      aria-label={`${media.sourceApp}, ${media.isPlaying ? "playing" : "paused"}`}
      className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400"
    >
      <span aria-hidden="true" className="flex h-4 shrink-0 items-end gap-[2px] opacity-80">
        <span className={`media-eq-bar w-[3px] rounded-full bg-zinc-400 ${media.isPlaying ? "media-eq-bar-active h-1.5" : "h-1.5"}`} />
        <span className={`media-eq-bar w-[3px] rounded-full bg-zinc-400 ${media.isPlaying ? "media-eq-bar-active h-2.5" : "h-1.5"}`} style={{ animationDelay: "0.3s" }} />
        <span className={`media-eq-bar w-[3px] rounded-full bg-zinc-400 ${media.isPlaying ? "media-eq-bar-active h-2" : "h-1.5"}`} style={{ animationDelay: "0.6s" }} />
      </span>
      <span className="max-w-32 truncate">{media.sourceApp}</span>
      <span className={`shrink-0 ${media.isPlaying ? "text-emerald-400" : "text-zinc-500"}`}>
        {media.isPlaying ? "Playing" : "Paused"}
      </span>
    </div>
  );
}

function SettingsTab({
  locked,
  error,
  version,
  autoUpdate,
  isChecking,
  isInstalling,
  updateStatus,
  availableUpdate,
  onToggleLock,
  onMove,
  onResetPosition,
  onQuit,
  onToggleAutoUpdate,
  onCheckUpdates,
  onInstallUpdate,
}: {
  locked: boolean;
  error: string;
  version: string;
  autoUpdate: boolean;
  isChecking: boolean;
  isInstalling: boolean;
  updateStatus: string;
  availableUpdate: Update | null;
  onToggleLock: () => void;
  onMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResetPosition: () => void;
  onQuit: () => void;
  onToggleAutoUpdate: (enabled: boolean) => void;
  onCheckUpdates: () => void;
  onInstallUpdate: (update: Update) => void;
}) {
  const LockIcon = locked ? LockKeyhole : UnlockKeyhole;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">Panel settings</h2>
        <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">
          {locked
            ? "Unpin to move. Position saves automatically."
            : "Hold and drag to move. Position saves automatically."}
        </p>
      </div>

      <button
        type="button"
        role="switch"
        aria-label="Pin panel position"
        aria-checked={locked}
        onClick={onToggleLock}
        className="flex shrink-0 items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-300/70"
      >
        <span className="flex items-center gap-2">
          <LockIcon size={16} className={locked ? "text-sky-300" : "text-zinc-400"} aria-hidden />
          <span className="text-xs font-medium text-zinc-100">
            {locked ? "Position pinned" : "Position unpinned"}
          </span>
        </span>
        <span
          className={`relative h-5 w-9 rounded-full transition-colors ${
            locked ? "bg-sky-500/80" : "bg-zinc-700"
          }`}
          aria-hidden
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              locked ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>

      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          disabled={locked}
          onPointerDown={onMove}
          className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs font-medium text-zinc-200 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-300/70 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Move size={14} aria-hidden />
          <span className="truncate">Hold and drag</span>
        </button>
        <button
          type="button"
          onClick={onResetPosition}
          className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs font-medium text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-300/70"
        >
          <RotateCcw size={14} aria-hidden />
          <span className="truncate">Reset position</span>
        </button>
      </div>

      <div className="shrink-0 border-t border-white/10 pt-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-100">Updates</h3>
          <span className="text-[10px] text-zinc-400">Version {version}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Check for updates automatically"
          aria-checked={autoUpdate}
          onClick={() => onToggleAutoUpdate(!autoUpdate)}
          className="mt-1 flex w-full items-center justify-between rounded-lg px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
        >
          <span className="text-[11px] text-zinc-300">Check for updates automatically</span>
          <span
            className={`relative h-4 w-7 rounded-full transition-colors ${
              autoUpdate ? "bg-sky-500/80" : "bg-zinc-700"
            }`}
            aria-hidden
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                autoUpdate ? "translate-x-[14px]" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
        <p role="status" className="min-h-4 text-[10px] leading-4 text-zinc-400">
          {updateStatus}
        </p>
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            disabled={isChecking || isInstalling}
            onClick={onCheckUpdates}
            className="flex min-w-0 flex-1 items-center justify-center rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] font-medium text-zinc-200 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-300/70 disabled:cursor-wait disabled:opacity-50"
          >
            {isChecking ? "Checking..." : "Check updates"}
          </button>
          {availableUpdate && (
            <button
              type="button"
              disabled={isInstalling}
              onClick={() => onInstallUpdate(availableUpdate)}
              className="flex min-w-0 flex-1 items-center justify-center rounded-lg border border-sky-400/20 bg-sky-500/10 px-2 py-1.5 text-[11px] font-medium text-sky-200 outline-none transition-colors hover:bg-sky-500/20 focus-visible:ring-2 focus-visible:ring-sky-300/70 disabled:cursor-wait disabled:opacity-50"
            >
              {isInstalling ? "Installing..." : `Install ${availableUpdate.version}`}
            </button>
          )}
        </div>
      </div>

      <div className="mt-auto shrink-0 border-t border-white/10 pt-2">
        <button
          type="button"
          onClick={onQuit}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 outline-none transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-300/70"
        >
          <Power size={14} aria-hidden />
          Exit Ridge
        </button>
      </div>

      {error && <p role="alert" className="text-[10px] text-amber-300">{error}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

function MediaTab({
  media,
  coverArt,
  onControl,
}: {
  media: MediaInfo | null;
  coverArt: string | null;
  onControl: (action: MediaAction) => void;
}) {
  const [seekPosition, setSeekPosition] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [mediaError, setMediaError] = useState("");

  useEffect(() => {
    if (!media || isSeeking) return;

    const basePosition = media.positionMs;
    const startedAt = performance.now();
    setSeekPosition(basePosition);

    if (!media.isPlaying || media.durationMs <= basePosition) return;

    let frame = 0;
    const updatePosition = (now: number) => {
      const elapsed = now - startedAt;
      const position = Math.min(media.durationMs, basePosition + elapsed);
      setSeekPosition(position);
      if (position >= media.durationMs) return;
      frame = window.requestAnimationFrame(updatePosition);
    };
    frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [media?.positionMs, media?.durationMs, media?.isPlaying, isSeeking]);

  const seek = async (position: number) => {
    if (!media || media.durationMs <= 0) return;
    try {
      const accepted = await invoke<boolean>("media_seek_to", {
        positionMs: Math.max(0, Math.min(media.durationMs, Math.round(position))),
      });
      setMediaError(accepted ? "" : "The player did not accept seeking");
    } catch (error) {
      console.error("media_seek_to failed:", error);
      setMediaError("Could not seek in the current track");
    } finally {
      setIsSeeking(false);
    }
  };

  if (!media?.hasSession) {
    return (
      <div className="flex h-full flex-col justify-center gap-3">
        <Empty
          Icon={Music2}
          title="Nothing is playing"
          body="Start playback in Spotify, a browser tab or VLC and it will show up here."
        />
        {mediaError && <p role="status" className="text-[10px] text-amber-300">{mediaError}</p>}
      </div>
    );
  }

  const PlayIcon = media.isPlaying ? Pause : Play;
  const displayedPosition = Math.min(seekPosition, media.durationMs);
  const progress = media.durationMs > 0 ? (displayedPosition / media.durationMs) * 100 : 0;

  return (
    <div className="flex h-full min-h-0 items-start gap-7">
      <div className="mt-[26px] grid h-32 w-32 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white/5">
        {coverArt ? (
          <img
            src={coverArt}
            alt={`${media.title || "Track"} album cover`}
            className="h-full w-full object-cover"
          />
        ) : (
          <Equalizer active={media.isPlaying} height={32} />
        )}
      </div>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col pt-4 pb-8">
        <div className="min-w-0">
          <p className="truncate text-xl font-semibold text-zinc-50">{media.title || "Unknown title"}</p>
          <p className="truncate text-sm text-zinc-400">{media.artist || "Unknown artist"}</p>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center gap-3">
          <ControlButton label="Previous track" onClick={() => onControl("previous")}>
            <SkipBack size={18} />
          </ControlButton>
          <ControlButton label={media.isPlaying ? "Pause" : "Play"} primary onClick={() => onControl("toggle")}>
            <PlayIcon size={20} />
          </ControlButton>
          <ControlButton label="Next track" onClick={() => onControl("next")}>
            <SkipForward size={18} />
          </ControlButton>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <span className="w-8 shrink-0 text-[10px] tabular-nums text-zinc-500">
            {formatTrackTime(displayedPosition)}
          </span>
          <input
            type="range"
            aria-label="Track position"
            min={0}
            max={Math.max(media.durationMs, 1)}
            step={250}
            value={displayedPosition}
            disabled={media.durationMs <= 0}
            onPointerDown={() => setIsSeeking(true)}
            onChange={(event) => {
              setIsSeeking(true);
              setSeekPosition(Number(event.currentTarget.value));
            }}
            onPointerUp={(event) => void seek(Number(event.currentTarget.value))}
            onKeyUp={(event) => void seek(Number(event.currentTarget.value))}
            style={{
              background: `linear-gradient(to right, rgb(161 161 170) 0%, rgb(161 161 170) ${progress}%, rgb(39 39 42) ${progress}%, rgb(39 39 42) 100%)`,
            }}
            className="h-2 min-w-0 flex-1 cursor-pointer accent-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-zinc-500">
            {formatTrackTime(media.durationMs)}
          </span>
        </div>
        {mediaError && <p role="status" className="text-[10px] text-amber-300">{mediaError}</p>}
      </div>
    </div>
  );
}

function formatTrackTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ControlButton({
  label,
  primary = false,
  onClick,
  children,
}: {
  label: string;
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-300/70 ${
        primary
          ? "h-11 w-11 bg-zinc-800 text-white shadow-md transition-all hover:bg-zinc-700"
          : "h-9 w-9 text-zinc-300 transition-all hover:bg-zinc-800/80 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Equalizer({ active, height }: { active: boolean; height: number }) {
  return (
    <div
      className={`flex items-end gap-[3px] ${height <= 10 ? "media-eq-compact" : ""}`}
      style={{ height }}
      aria-hidden
    >
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className={`media-eq-bar w-[3px] rounded-full bg-sky-300 ${
            active ? "media-eq-bar-active h-1.5" : "h-1"
          }`}
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Clipboard (UI only; history capture is a separate backend module)          */
/* -------------------------------------------------------------------------- */

function ClipboardTab({
  items,
  error,
  onClear,
}: {
  items: string[];
  error: string | null;
  onClear: () => void;
}) {
  const [notice, setNotice] = useState("");

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard");
      window.setTimeout(() => setNotice(""), 1500);
    } catch (error) {
      console.error("clipboard copy failed:", error);
      setNotice("Could not access the clipboard");
    }
  };

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <ClipboardList size={22} className="text-zinc-500" aria-hidden />
        <p className="text-sm font-medium text-zinc-200">
          {error ? "Clipboard unavailable" : "No copied text yet"}
        </p>
        <p className="max-w-[280px] text-xs leading-relaxed text-zinc-500">
          {error ||
            "Text copied while Ridge is running appears here. The last 40 items stay in memory and are not saved to disk."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between">
        <span className="text-xs text-zinc-400">Recent text · {items.length}/40</span>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          <Trash2 size={12} aria-hidden />
          Clear
        </button>
      </div>
      {error && <p role="alert" className="shrink-0 text-xs text-rose-300">{error}</p>}
      {notice && <p role="status" className="shrink-0 text-xs text-sky-300">{notice}</p>}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {items.map((item, index) => (
          <li
            key={`${index}-${item.slice(0, 40)}`}
            className="flex items-start gap-2 rounded-lg bg-white/5 px-2.5 py-2"
          >
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-200">
              {item}
            </p>
            <button
              type="button"
              aria-label="Copy this item"
              title="Copy"
              onClick={() => void copy(item)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <Copy size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* File shelf                                                                 */
/* -------------------------------------------------------------------------- */

function FileShelf({
  files,
  isDragging,
  status,
  onFilesDropped,
  onStatusChange,
  onFileDragStart,
  onFileDragEnd,
  onMissingFiles,
  dismissedScreenshots,
  onDismissScreenshots,
  onRemove,
  onClear,
}: {
  files: string[];
  isDragging: boolean;
  status: string;
  onFilesDropped: (paths: string[]) => void;
  onStatusChange: (status: string) => void;
  onFileDragStart: () => void;
  onFileDragEnd: () => void;
  onMissingFiles: (paths: string[]) => void;
  dismissedScreenshots: string[];
  onDismissScreenshots: (paths: string[]) => void;
  onRemove: (path: string) => Promise<void>;
  onClear: () => void;
}) {
  const [htmlDragActive, setHtmlDragActive] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const requestedPreviews = useRef(new Map<string, Promise<string>>());
  const [folderScreenshots, setFolderScreenshots] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let disposed = false;
    for (const path of files) {
      if (!/\.(png|jpe?g)$/i.test(path)) continue;

      let request = requestedPreviews.current.get(path);
      if (!request) {
        request = invoke<string>("get_shelf_image_preview", { path });
        requestedPreviews.current.set(path, request);
      }

      request
        .then((preview) => {
          if (!disposed) setPreviews((current) => ({ ...current, [path]: preview }));
        })
        .catch((error: unknown) => {
          if (requestedPreviews.current.get(path) === request) {
            requestedPreviews.current.delete(path);
          }
          if (!disposed) {
            console.error("get_shelf_image_preview failed:", error);
            onStatusChange(`Could not load image preview: ${path.split(/[\\/]/).pop() || path}`);
          }
        });
    }
    return () => {
      disposed = true;
    };
  }, [files, onStatusChange]);

  useEffect(() => {
    let disposed = false;
    const syncShelf = async () => {
      try {
        const [screenshots, existingPaths] = await Promise.all([
          invoke<string[]>("list_screenshots"),
          files.length > 0
            ? invoke<string[]>("get_existing_shelf_paths", { paths: files })
            : Promise.resolve([]),
        ]);
        if (disposed) return;
        const screenshotSet = new Set(screenshots);
        setFolderScreenshots((current) =>
          current.size === screenshotSet.size &&
          screenshots.every((path) => current.has(path))
            ? current
            : screenshotSet,
        );
        const dismissed = new Set(dismissedScreenshots);
        const visibleScreenshots = screenshots.filter((path) => !dismissed.has(path));
        if (visibleScreenshots.length > 0) onFilesDropped(visibleScreenshots);
        const existing = new Set(existingPaths);
        const missing = files.filter((path) => !existing.has(path));
        if (missing.length > 0) onMissingFiles(missing);
      } catch (error) {
        console.error("shelf synchronization failed:", error);
        if (!disposed) onStatusChange("Could not sync shelf files with disk");
      }
    };

    void syncShelf();
    const interval = window.setInterval(() => void syncShelf(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [dismissedScreenshots, files, onFilesDropped, onMissingFiles, onStatusChange]);

  const startNativeFileDrag = async (event: ReactDragEvent<HTMLLIElement>, path: string) => {
    event.preventDefault();
    if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(path)) {
      onStatusChange("This item does not have an absolute file path");
      return;
    }

    onFileDragStart();
    try {
      const image = previews[path] ?? createGenericDragPreview();
      const onEvent = new Channel<NativeFileDragEvent>(({ result }) => {
        onStatusChange(result === "Dropped" ? "File dropped outside Ridge" : "File drag cancelled");
      });
      await invoke("plugin:drag|start_drag", {
        item: [path],
        image,
        options: { mode: "copy" },
        onEvent,
      });
    } catch (error) {
      console.error("native file drag failed:", error);
      onStatusChange("Could not start dragging this file");
    } finally {
      onFileDragEnd();
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setHtmlDragActive(false);
    const paths = droppedFilePaths(event.dataTransfer.files);

    if (paths.length > 0) {
      onFilesDropped(paths);
      onStatusChange("Files added to shelf");
    } else if (event.dataTransfer.files.length > 0) {
      onStatusChange("Use the native file drop target to add files from Explorer.");
    }
  };

  return (
    <div
      className={`flex h-full flex-col gap-2 rounded-lg transition-colors ${
        isDragging || htmlDragActive ? "bg-sky-300/5 ring-1 ring-inset ring-sky-300/40" : ""
      }`}
      onDragEnter={(event) => {
        event.preventDefault();
        setHtmlDragActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setHtmlDragActive(true);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setHtmlDragActive(false);
      }}
      onDrop={handleDrop}
    >
      {files.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <FolderOpen size={22} className="text-zinc-500" aria-hidden />
          <p className="text-sm font-medium text-zinc-200">
            {isDragging || htmlDragActive ? "Drop files to add them" : "The shelf is empty"}
          </p>
          <p className="max-w-[280px] text-xs leading-relaxed text-zinc-500">
            Drop files onto the bar. Screenshots are saved in Pictures\Screenshots; dropped files stay on the shelf for this session.
          </p>
          {status && <p role="status" className="text-xs text-amber-300">{status}</p>}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between">
            <span className="text-xs text-zinc-400">{files.length} file{files.length === 1 ? "" : "s"}</span>
            <button
              type="button"
              onClick={() => {
                onDismissScreenshots(
                  files.filter((path) => folderScreenshots.has(path)),
                );
                onClear();
              }}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <Trash2 size={12} aria-hidden />
              Clear
            </button>
          </div>
          {status && <p role="status" className="shrink-0 text-xs text-amber-300">{status}</p>}
          <ul className="min-h-0 flex-1 grid auto-rows-max grid-cols-2 content-start gap-2 overflow-y-auto pr-1">
            {files.map((path) => {
              const name = path.split(/[\\/]/).pop() || path;
              return (
                <li
                  key={path}
                  draggable={true}
                  onDragStart={(event) => void startNativeFileDrag(event, path)}
                  title="Drag this file out of Ridge"
                  className="relative min-w-0 cursor-grab overflow-hidden rounded-lg bg-white/5 active:cursor-grabbing"
                >
                  {previews[path] ? (
                    <img
                      src={previews[path]}
                      alt={`Preview of ${name}`}
                      draggable={false}
                      className="block h-24 w-full bg-zinc-950 object-contain"
                    />
                  ) : (
                    <div className="grid h-24 place-items-center bg-white/[0.03]">
                      <FolderOpen size={24} className="text-zinc-500" aria-hidden />
                    </div>
                  )}
                  <button
                    type="button"
                    draggable={false}
                    aria-label={`Delete ${name}`}
                    title="Delete screenshot from disk or remove file from shelf"
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onRemove(path);
                    }}
                    className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-zinc-950/85 text-zinc-100 shadow-md outline-none hover:bg-rose-600 focus-visible:ring-2 focus-visible:ring-rose-300"
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                  <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-zinc-100" title={name}>{name}</span>
                    </span>
                    {folderScreenshots.has(path) && (
                      <span className="flex shrink-0 items-center">
                        <button
                          type="button"
                          draggable={false}
                          aria-label={`Copy image ${name}`}
                          title="Copy image"
                          onDragStart={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            invoke("copy_image_to_clipboard", { path })
                              .then(() => onStatusChange("Image copied"))
                              .catch((error: unknown) => {
                                console.error("copy_image_to_clipboard failed:", error);
                                onStatusChange("Could not copy image to clipboard");
                              });
                          }}
                          className="grid h-7 w-7 place-items-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                        >
                          <Copy size={14} aria-hidden />
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

function CalendarTab() {
  const locale = navigator.language;
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(cursor);

  // 1 Jan 2024 is a Monday, so the week starts on Monday.
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1 + i)),
      ),
    [locale],
  );

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const leading = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return [
      ...Array.from<number | null>({ length: leading }).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];
  }, [cursor]);

  const today = new Date();
  const isCurrentMonth =
    cursor.getMonth() === today.getMonth() && cursor.getFullYear() === today.getFullYear();
  const isToday = (day: number) =>
    day === today.getDate() &&
    isCurrentMonth;

  const shift = (delta: number) =>
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold capitalize text-zinc-100">{monthLabel}</p>
        <div className="flex items-center gap-1">
          {!isCurrentMonth && (
            <button
              type="button"
              onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
              className="rounded px-2 py-1 text-[11px] font-medium text-zinc-400 outline-none hover:bg-white/10 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-300/70"
            >
              Today
            </button>
          )}
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => shift(-1)}
            className="grid h-6 w-6 place-items-center rounded-full text-zinc-400 outline-none hover:bg-white/10 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-300/70"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => shift(1)}
            className="grid h-6 w-6 place-items-center rounded-full text-zinc-400 outline-none hover:bg-white/10 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-300/70"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-center text-[11px] uppercase text-zinc-500">
        {weekdays.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs tabular-nums">
        {cells.map((day, i) =>
          day === null ? (
            <span key={`pad-${i}`} />
          ) : (
            <span
              key={day}
              className={`mx-auto grid h-6 w-6 place-items-center rounded-full ${
                isToday(day) ? "bg-sky-300 font-semibold text-zinc-950" : "text-zinc-300"
              }`}
            >
              {day}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

function Empty({ Icon, title, body }: { Icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <Icon size={22} className="text-zinc-500" aria-hidden />
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      <p className="max-w-[260px] text-xs leading-relaxed text-zinc-500">{body}</p>
    </div>
  );
}
