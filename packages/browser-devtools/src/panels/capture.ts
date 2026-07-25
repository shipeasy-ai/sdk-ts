// Screen capture utilities for bug reports.
//
// Both screenshots and screen recordings go through getDisplayMedia: this asks
// the browser for permission (the picker shows the current tab/window/screen),
// so it works inside an iframe-loaded devtools without needing any host SDK
// support. For screenshots we grab a single video frame and stop the track;
// for recordings we hand the stream to MediaRecorder.

// `preferCurrentTab`, `selfBrowserSurface`, `surfaceSwitching`, `systemAudio`,
// and `monitorTypeSurfaces` are Chrome-only extensions to MediaStreamConstraints
// (Chrome Capture Handle / Region Capture extensions). They're ignored by
// browsers that don't recognize them, so they're safe to pass unconditionally.
interface ChromeDisplayMediaConstraints extends MediaStreamConstraints {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
}

declare global {
  interface MediaDevices {
    getDisplayMedia(constraints?: ChromeDisplayMediaConstraints): Promise<MediaStream>;
  }
}

// Hide the entire devtools shadow host (sidebar + any open modal) so it doesn't
// appear in the captured frame / recording. Returns a restore function.
function hideHost(host: HTMLElement | null | undefined): () => void {
  if (!host) return () => {};
  const prev = host.style.visibility;
  host.style.visibility = "hidden";
  return () => {
    host.style.visibility = prev;
  };
}

export async function captureScreenshot(host?: HTMLElement | null): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture is not supported in this browser.");
  }
  // Hide the devtools host BEFORE requesting the stream — otherwise the first
  // few frames the stream emits can still contain the panel (the visibility
  // change wouldn't have repainted into the capture surface yet by the time
  // we grab the frame). The picker dialog overlays the page so the user
  // never sees the page flicker.
  const restore = hideHost(host);
  let stream: MediaStream;
  try {
    // preferCurrentTab collapses the picker to a one-click confirm for the
    // current tab — by far the right UX for "screenshot this page". Chromium
    // ignores the rest of the surface options when this is set; we keep them
    // for browsers that ignore preferCurrentTab but honor the others.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
      monitorTypeSurfaces: "exclude",
    });
  } catch (err) {
    restore();
    throw err;
  }
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    // play() resolves before the first frame is decoded; wait for both
    // loadedmetadata (so videoWidth/Height are set) and one rAF tick.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Capture stream timed out")), 5000);
      video.onloadedmetadata = () => {
        clearTimeout(t);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(t);
        reject(new Error("Capture stream errored"));
      };
    });
    await video.play();
    // Two rAF ticks: one for the visibility:hidden repaint to land in the
    // capture stream, one for play() to actually decode a frame.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error("Capture stream returned no frames.");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2d context unavailable");
    ctx.drawImage(video, 0, 0, w, h);
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    return blob;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    restore();
  }
}

export interface RecordingHandle {
  stop(): Promise<Blob>;
  cancel(): void;
}

export async function startRecording(
  host?: HTMLElement | null,
  onEnded?: () => void,
): Promise<RecordingHandle> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture is not supported in this browser.");
  }
  // Hide BEFORE getDisplayMedia so the first frames the stream emits don't
  // capture the panel. The picker dialog blocks input while it's open, so
  // the user doesn't see the hidden state.
  const restore = hideHost(host);
  let stream: MediaStream;
  try {
    // Same one-click confirm UX as the screenshot path — preferCurrentTab
    // collapses the picker to a single "Share this tab?" prompt for the
    // current tab. With audio:true Chromium offers the share-tab-audio toggle
    // inline in that prompt.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, displaySurface: "browser" },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    });
  } catch (err) {
    restore();
    throw err;
  }
  // Let the visibility:hidden repaint reach the capture stream before we
  // start collecting chunks, so the opening frames don't show the panel.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  // Pick a mime type the browser actually supports (Safari is webm-shy).
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  recorder.start(500);

  // Stop early if the user clicks "Stop sharing" in the browser's UI. Also
  // restore the devtools panel so the user isn't left looking at a hidden UI,
  // and notify the caller so it can finalize the attachment without making
  // the user click "Stop recording" a second time in our own UI.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    restore();
    if (recorder.state !== "inactive") recorder.stop();
    onEnded?.();
  });

  function stopTracks() {
    stream.getTracks().forEach((t) => t.stop());
    restore();
  }

  return {
    stop(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        if (recorder.state === "inactive") {
          stopTracks();
          if (chunks.length === 0) {
            reject(new Error("No recording data."));
            return;
          }
          resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
          return;
        }
        recorder.addEventListener(
          "stop",
          () => {
            stopTracks();
            resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
          },
          { once: true },
        );
        recorder.addEventListener("error", (e) => reject(e), { once: true });
        recorder.stop();
      });
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
      stopTracks();
    },
  };
}
