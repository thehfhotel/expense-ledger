import { useEffect } from "react";
import { PHOTO } from "../labels.ts";

interface Props {
  url: string;
  onClose: () => void;
}

/** The photo lightbox — an overlay, not a route (frontend spec §1). Esc and
 * a backdrop click both close it. */
export function PhotoLightbox({ url, onClose }: Props) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative full-size receipt photo, no meaningful alt text to give */}
      <img src={url} className="max-h-full max-w-full rounded-lg" onClick={(e) => e.stopPropagation()} />
      <button
        type="button"
        onClick={onClose}
        aria-label={PHOTO.close}
        className="absolute right-4 top-4 rounded-full bg-black/50 px-3 py-1.5 text-sm font-medium text-white hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60"
      >
        {PHOTO.close}
      </button>
    </div>
  );
}
