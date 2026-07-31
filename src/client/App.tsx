import { useEffect, useState } from "react";
import { isExpenseCategoryCode, type ExpenseCategoryCode } from "../shared/categories.ts";
import { currentMonthBangkok, isValidMonth } from "../shared/date.ts";
import type { ApListFilter } from "../shared/apTypes.ts";
import { setSessionExpiredHandler } from "./api.ts";
import { SessionExpiredOverlay } from "./components/SessionExpiredOverlay.tsx";
import { APP_TITLE, NAV, pageTitle } from "./labels.ts";
import { ApPage } from "./pages/ApPage.tsx";
import { EntryPage } from "./pages/EntryPage.tsx";
import { MonthPage } from "./pages/MonthPage.tsx";

// pushState micro-router, copied from income-ledger's src/client/App.tsx —
// no library, no hash routing (frontend spec §1). Three real routes; the
// edit drawer and photo lightbox are overlays, not routes.

const SHELL_WIDTH = "mx-auto w-full max-w-[1100px]";

type Route =
  | { kind: "entry"; cat?: ExpenseCategoryCode }
  | { kind: "month"; month: string }
  | { kind: "ap"; filter: ApListFilter };

/** Mirrors src/server/server.ts's GET /api/ap/rows precedence exactly: a
 * valid `m` always wins over `f` (a month value implies month-filter mode,
 * spec §2 "?m=YYYY-MM (implies month filter)"). */
function parseApFilter(search: string): ApListFilter {
  const params = new URLSearchParams(search);
  const m = params.get("m");
  if (m && isValidMonth(m)) return { mode: "month", month: m };
  const f = params.get("f");
  return { mode: f === "all" ? "all" : "open" };
}

function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts[0] === "month" && parts[1] && isValidMonth(parts[1])) {
    return { kind: "month", month: parts[1] };
  }
  if (parts[0] === "ap") {
    return { kind: "ap", filter: parseApFilter(search) };
  }
  const params = new URLSearchParams(search);
  const catParam = params.get("cat");
  return { kind: "entry", cat: isExpenseCategoryCode(catParam) ? catParam : undefined };
}

export function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname, location.search));
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname, location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => setSessionExpired(true));
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    const screen = route.kind === "month" ? NAV.month : route.kind === "ap" ? NAV.ap : NAV.entry;
    document.title = pageTitle(screen);
  }, [route.kind]);

  const navItems: { key: string; label: string; active: boolean; path: string }[] = [
    { key: "entry", label: NAV.entry, active: route.kind === "entry", path: "/entry" },
    { key: "month", label: NAV.month, active: route.kind === "month", path: `/month/${currentMonthBangkok()}` },
    { key: "ap", label: NAV.ap, active: route.kind === "ap", path: "/ap" },
  ];

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-brand-900 bg-brand-800">
        <div className={SHELL_WIDTH + " flex items-center justify-between gap-3 px-4 py-3"}>
          <span className="text-sm font-semibold tracking-wide text-white">{APP_TITLE}</span>
        </div>
        <nav className={"rail " + SHELL_WIDTH + " flex gap-1 overflow-x-auto px-4 pb-2"}>
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.path)}
              className={
                "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (item.active ? "bg-gold-500 text-brand-900" : "text-brand-100 hover:bg-brand-700")
              }
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className={SHELL_WIDTH + " min-w-0 px-4 py-4"}>
        {route.kind === "entry" && <EntryPage key={route.cat ?? "none"} initialCategoryCode={route.cat} />}
        {route.kind === "month" && <MonthPage key={route.month} month={route.month} />}
        {route.kind === "ap" && <ApPage filter={route.filter} />}
      </main>

      {sessionExpired && <SessionExpiredOverlay />}
    </div>
  );
}
