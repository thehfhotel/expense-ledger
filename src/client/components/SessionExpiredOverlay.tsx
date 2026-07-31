import { SESSION_ERROR } from "../labels.ts";

/**
 * Full-screen overlay for an Access session that expired while the tab was
 * open (frontend spec §6 — the estate's "open but dead" symptom). Not a
 * route: App.tsx renders this above everything else whenever api.ts
 * classifies a response as session-expired (401/403, or non-JSON content
 * type from an Access login-page redirect).
 */
export function SessionExpiredOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg bg-panel p-6 text-center shadow-lg">
        <h2 className="text-base font-semibold text-ink">{SESSION_ERROR.title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{SESSION_ERROR.body}</p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="mt-4 w-full rounded-md bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          {SESSION_ERROR.reload}
        </button>
      </div>
    </div>
  );
}
