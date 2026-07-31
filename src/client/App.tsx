import { useEffect, useState } from "react";
import { isExpenseCategoryCode, type ExpenseCategoryCode } from "../shared/categories.ts";
import { currentMonthBangkok, isValidMonth } from "../shared/date.ts";
import { setSessionExpiredHandler } from "./api.ts";
import { SessionExpiredOverlay } from "./components/SessionExpiredOverlay.tsx";
import { APP_TITLE, NAV, pageTitle } from "./labels.ts";
import { EntryPage } from "./pages/EntryPage.tsx";
import { MonthPage } from "./pages/MonthPage.tsx";

// pushState micro-router, copied from income-ledger's src/client/App.tsx —
// no library, no hash routing (frontend spec §1). Two real routes; the
// edit drawer and photo lightbox are overlays, not routes.

const SHELL_WIDTH = "mx-auto w-full max-w-[1100px]";

type Route = { kind: "entry"; cat?: ExpenseCategoryCode } | { kind: "month"; month: string };

function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts[0] === "month" && parts[1] && isValidMonth(parts[1])) {
    return { kind: "month", month: parts[1] };
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
    document.title = pageTitle(route.kind === "month" ? NAV.month : NAV.entry);
  }, [route.kind]);

  const navItems: { key: string; label: string; active: boolean; path: string }[] = [
    { key: "entry", label: NAV.entry, active: route.kind === "entry", path: "/entry" },
    { key: "month", label: NAV.month, active: route.kind === "month", path: `/month/${currentMonthBangkok()}` },
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
      </main>

      {sessionExpired && <SessionExpiredOverlay />}
    </div>
  );
}
