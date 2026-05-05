import { useEffect, useRef, useState } from "react";

/**
 * Fullscreen fixed cyberpunk background.
 *
 * Looks for `/background.mp4` (drop your video into `public/background.mp4`).
 * If the video fails to load — or the user hasn't dropped one in yet — we fall
 * back to a CSS gradient mesh that captures the same neon-cyber mood. Either
 * way, a dark overlay sits on top so foreground text stays readable.
 */
export function AnimatedBackground() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoOk, setVideoOk] = useState(true);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // Some browsers reject autoplay until the video is muted in JS too.
    v.muted = true;
    const onErr = () => setVideoOk(false);
    v.addEventListener("error", onErr);
    return () => v.removeEventListener("error", onErr);
  }, []);

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-ink-200">
      {videoOk && (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          src="/background.mp4"
          autoPlay
          loop
          muted
          playsInline
          // If decoding fails, the onError fires and we hide the video, leaving the gradient.
          onError={() => setVideoOk(false)}
        />
      )}

      {/* CSS fallback / atmosphere layer — visible underneath the video too,
          giving the page color the moment the cyber video loads. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-90"
        style={{
          background: `
            radial-gradient(60% 40% at 18% 18%, rgba(178, 59, 255, 0.45), transparent 60%),
            radial-gradient(50% 35% at 82% 22%, rgba(61, 255, 252, 0.35), transparent 60%),
            radial-gradient(70% 50% at 50% 110%, rgba(255, 61, 111, 0.45), transparent 60%),
            radial-gradient(45% 35% at 90% 80%, rgba(116, 255, 61, 0.30), transparent 60%),
            linear-gradient(180deg, #0b0d11 0%, #0e0f12 100%)
          `,
        }}
      />

      {/* Top-down dark overlay for readability of foreground glass cards */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(14,15,18,0.55) 0%, rgba(14,15,18,0.35) 40%, rgba(14,15,18,0.55) 100%)",
        }}
      />

      {/* Faint vignette */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: "radial-gradient(120% 80% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </div>
  );
}
