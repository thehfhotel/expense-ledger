import { useEffect, useMemo, useState } from "react";
import { EngineUnreachableError, SessionExpiredError, listApRows } from "../api.ts";
import { navigate } from "../App.tsx";
import { currentMonthBangkok, isoToBuddhist, monthToThaiLong, shiftMonths, todayBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import { categoryByCode } from "../../shared/categories.ts";
import {
  apRowPhotoCount,
  deriveStatus,
  statusRank,
  type ApListFilter,
  type ApRow,
  type ApRowsResponse,
  type ApStatus,
} from "../../shared/apTypes.ts";
import { ApPaymentForm } from "../components/ApPaymentForm.tsx";
import { ApRowDrawer } from "../components/ApRowDrawer.tsx";
import {
  AP,
  AP_EMPTY,
  AP_FIELDS,
  AP_PAY,
  AP_STATUS,
  AP_STORE_ERROR,
  EMPTY_VALUE,
  ENGINE_ERROR,
  LOADING,
  MONTH_HEADER,
  loadFailedDetail,
} from "../labels.ts";

interface Props {
  filter: ApListFilter;
}

const HIGHLIGHT_MS = 300;

const REGISTER_COLUMNS = "grid-cols-[11rem_1fr_7.5rem_6rem_7rem_7rem_4.5rem]";

function statusChipClasses(status: ApStatus): string {
  if (status === "overdue") return "border-bad/40 text-bad";
  if (status === "dueSoon") return "border-gold-700/40 text-gold-700";
  if (status === "settled") return "border-ok/40 text-ok";
  return "border-line-strong text-ink-muted";
}

function statusLabel(status: ApStatus): string {
  if (status === "overdue") return AP_STATUS.overdue;
  if (status === "dueSoon") return AP_STATUS.dueSoon;
  if (status === "settled") return AP_STATUS.settled;
  return AP_STATUS.open;
}

/** RULING 1 (2026-07): a neutral label for the register's category chip —
 * the real leaf label once one is set, else the explicit "ไม่ระบุหมวด"
 * state (never blank/undefined). */
function categoryChipLabel(row: ApRow): string {
  return row.categoryCode ? categoryByCode(row.categoryCode).label : AP_FIELDS.categoryUnset;
}

/** statusRank -> dueDate ascending (nulls last) -> createdAt descending
 * (spec §3 "Overdue emphasis + sort") — the ONE fixed order, no user-facing
 * sort control. */
function sortRows(rows: ApRow[], today: string): ApRow[] {
  return [...rows].sort((a, b) => {
    const rankDiff =
      statusRank(deriveStatus(a.dueDate, a.outstandingSatang, today)) -
      statusRank(deriveStatus(b.dueDate, b.outstandingSatang, today));
    if (rankDiff !== 0) return rankDiff;

    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }

    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return 0;
  });
}

/**
 * Screen 3 — ค้างจ่าย (design spec): a rolling AP register. Default view
 * (ค้างจ่าย, ignoring month entirely) answers "what do we still owe, what's
 * late" in zero clicks; recording a payment takes two.
 */
export function ApPage({ filter }: Props) {
  const [data, setData] = useState<ApRowsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<{ kind: "add" } | { kind: "edit"; rowId: string } | null>(null);
  const [payingRowId, setPayingRowId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  function fetchRows() {
    return listApRows(filter)
      .then((res) => setData(res))
      .catch((err) => {
        // L1 fix: never show a raw English error token — ap_store_error
        // (the AP register's own sqlite failing) and engine_unreachable each
        // get their own distinct Thai message; anything else falls back to
        // the raw message (still not ideal, but at least not one of these
        // two commonly-hit tokens).
        if (err instanceof SessionExpiredError) return;
        if (err instanceof EngineUnreachableError) {
          setLoadError(ENGINE_ERROR.message);
        } else if (err instanceof Error && err.message === "ap_store_error") {
          setLoadError(AP_STORE_ERROR.detail);
        } else {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
  }

  useEffect(() => {
    setData(null);
    setLoadError(null);
    void fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.mode, filter.month]);

  const today = todayBangkok();
  const sortedRows = useMemo(() => (data ? sortRows(data.rows, today) : []), [data, today]);

  const editingRow: ApRow | null =
    drawerMode?.kind === "edit" ? (data?.rows.find((r) => r.id === drawerMode.rowId) ?? null) : null;
  const payingRow: ApRow | null = payingRowId ? (data?.rows.find((r) => r.id === payingRowId) ?? null) : null;

  // "no rows at all" (spec §7) needs a signal independent of the active
  // filter — `creditors` is server-supplied from EVERY row regardless of
  // f=/m= (src/server/apStore.ts's listCreditorHints), so an empty list
  // here means the register has never had a single row, distinct from
  // "all settled" or "none this month".
  const noRowsAtAll = data !== null && data.creditors.length === 0;

  const activeMonth = filter.mode === "month" ? filter.month! : currentMonthBangkok();

  function openAdd() {
    setDrawerMode({ kind: "add" });
  }
  function openEdit(row: ApRow) {
    setDrawerMode({ kind: "edit", rowId: row.id });
  }
  function closeDrawer() {
    setDrawerMode(null);
  }
  function flash(id: string) {
    setHighlightId(id);
    setTimeout(() => setHighlightId((current) => (current === id ? null : current)), HIGHLIGHT_MS);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5 rounded-md bg-tint p-1">
            <button
              type="button"
              onClick={() => navigate("/ap")}
              aria-pressed={filter.mode === "open"}
              className={
                "rounded px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                (filter.mode === "open" ? "bg-panel text-brand-700 shadow-sm" : "text-ink-muted hover:text-ink")
              }
            >
              {AP.filterOpen}
            </button>
            <button
              type="button"
              onClick={() => navigate("/ap?f=all")}
              aria-pressed={filter.mode === "all"}
              className={
                "rounded px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                (filter.mode === "all" ? "bg-panel text-brand-700 shadow-sm" : "text-ink-muted hover:text-ink")
              }
            >
              {AP.filterAll}
            </button>
          </div>

          <div role="group" aria-label={AP.filterMonth} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => navigate(`/ap?m=${shiftMonths(activeMonth, -1)}`)}
              aria-label={MONTH_HEADER.prevMonth}
              className="rounded-md border border-line-strong px-2 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => navigate(`/ap?m=${activeMonth}`)}
              aria-pressed={filter.mode === "month"}
              className={
                "rounded-md px-2 py-1.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                (filter.mode === "month" ? "bg-tint text-brand-700" : "text-ink-muted hover:text-ink")
              }
            >
              {monthToThaiLong(activeMonth)}
            </button>
            <button
              type="button"
              onClick={() => navigate(`/ap?m=${shiftMonths(activeMonth, 1)}`)}
              aria-label={MONTH_HEADER.nextMonth}
              className="rounded-md border border-line-strong px-2 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              ›
            </button>
            {filter.mode === "month" && filter.month !== currentMonthBangkok() && (
              <button
                type="button"
                onClick={() => navigate(`/ap?m=${currentMonthBangkok()}`)}
                className="ml-1 text-xs font-medium text-brand-500 hover:underline"
              >
                {MONTH_HEADER.backToCurrent}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {data && (
            <span className="text-base font-bold tabular-nums text-ink">
              {AP.totalOutstanding} ฿{formatSatang(data.summary.totalOutstandingSatang)}
            </span>
          )}
          {data && data.summary.overdueCount > 0 && (
            <span className="text-sm font-semibold text-bad">{AP.overdueCount(data.summary.overdueCount)}</span>
          )}
          <button
            type="button"
            onClick={openAdd}
            className="rounded-md bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600"
          >
            {AP.add}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">{loadFailedDetail(loadError)}</div>
      )}
      {!loadError && data === null && <div className="p-6 text-sm text-ink-muted">{LOADING}</div>}

      {!loadError && data !== null && sortedRows.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink-muted">
          <span>
            {noRowsAtAll
              ? AP_EMPTY.none
              : filter.mode === "month"
                ? AP_EMPTY.noneMonth
                : filter.mode === "open"
                  ? AP_EMPTY.noneOpen
                  : AP_EMPTY.none}
          </span>
          {(noRowsAtAll || filter.mode !== "month") && (
            <button
              type="button"
              onClick={openAdd}
              className="rounded-md bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600"
            >
              {AP.add}
            </button>
          )}
        </div>
      )}

      {!loadError && data !== null && sortedRows.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          {/* Desktop / tablet grid (spec §3) */}
          <div className="hidden md:block">
            <div
              className={"grid gap-2 border-b border-line bg-tint px-4 py-2 text-xs font-semibold text-ink-muted " + REGISTER_COLUMNS}
            >
              <span>{AP_FIELDS.creditor}</span>
              <span>{AP_FIELDS.item}</span>
              <span className="text-right">{AP_FIELDS.outstanding}</span>
              <span>{AP_FIELDS.dueDate}</span>
              <span>{AP_FIELDS.entity}</span>
              <span>{AP_FIELDS.status}</span>
              <span />
            </div>
            <div className="divide-y divide-line">
              {sortedRows.map((row) => {
                const status = deriveStatus(row.dueDate, row.outstandingSatang, today);
                const isOverdue = status === "overdue";
                const isSettled = status === "settled";
                return (
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openEdit(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openEdit(row);
                      }
                    }}
                    className={
                      "relative grid cursor-pointer items-start gap-2 px-4 py-2 text-sm hover:bg-tint focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40 " +
                      REGISTER_COLUMNS +
                      (isOverdue ? " bg-bad/5" : "") +
                      (highlightId === row.id ? " bg-gold-100" : "")
                    }
                  >
                    {isOverdue && <span className="absolute inset-y-0 left-0 w-0.5 bg-bad" aria-hidden="true" />}
                    {/* Owner rule: ชื่อเจ้าหนี้/รายการ must always be fully
                        readable — wraps to multiple lines instead of
                        clipping (no `truncate`); the row grows to fit, never
                        a horizontal scroll (the ENGINE COMMENT's own
                        255-rune upstream cap is unaffected — see
                        src/server/attribution.ts — this register row stays
                        the full-text source of truth regardless). */}
                    <span className="min-w-0 break-words text-ink">{row.creditor}</span>
                    <span className="min-w-0 text-ink">
                      <span className="block break-words">{row.item}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1">
                        <span className="inline-block truncate rounded-full border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-muted">
                          {categoryChipLabel(row)}
                        </span>
                        {apRowPhotoCount(row.photos) !== null && (
                          <span className="inline-block truncate rounded-full border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-muted">
                            {AP_FIELDS.photoCount(apRowPhotoCount(row.photos)!)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className={"text-right tabular-nums font-semibold " + (isOverdue ? "text-bad" : "text-ink")}>
                      ฿{formatSatang(row.outstandingSatang)}
                    </span>
                    <span className="tabular-nums text-ink">{row.dueDate ? isoToBuddhist(row.dueDate) : EMPTY_VALUE}</span>
                    <span className="min-w-0 truncate text-ink-muted">{row.entity || EMPTY_VALUE}</span>
                    <span>
                      {isSettled ? (
                        <span className="text-xs font-medium text-ok">
                          {/* H3 fix: settledAt is null-guarded even though the
                              server now derives a fallback date for a
                              zero-payment settled row — a stale client or an
                              edge case not yet accounted for must never white-
                              screen here. */}
                          {AP_STATUS.settledOn(row.settledAt ? isoToBuddhist(row.settledAt) : EMPTY_VALUE)}
                        </span>
                      ) : (
                        <span
                          className={"inline-block rounded-full border bg-panel px-2 py-0.5 text-xs font-medium " + statusChipClasses(status)}
                        >
                          {statusLabel(status)}
                        </span>
                      )}
                    </span>
                    <span>
                      {!isSettled && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPayingRowId(row.id);
                          }}
                          className="rounded-md border border-line-strong bg-panel px-2.5 py-1 text-xs font-semibold text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                        >
                          {AP_PAY.action}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile card list (< 768px, spec §3) */}
          <div className="divide-y divide-line md:hidden">
            {sortedRows.map((row) => {
              const status = deriveStatus(row.dueDate, row.outstandingSatang, today);
              const isOverdue = status === "overdue";
              const isSettled = status === "settled";
              return (
                <div
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openEdit(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openEdit(row);
                    }
                  }}
                  className={
                    "relative flex cursor-pointer flex-col gap-1 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40" +
                    (isOverdue ? " bg-bad/5" : "") +
                    (highlightId === row.id ? " bg-gold-100" : "")
                  }
                >
                  {isOverdue && <span className="absolute inset-y-0 left-0 w-0.5 bg-bad" aria-hidden="true" />}
                  {/* Owner rule — see the desktop grid's identical comment
                      above: ชื่อเจ้าหนี้/รายการ never clip, they wrap. */}
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-words font-medium text-ink">{row.creditor}</span>
                    <span className={"shrink-0 tabular-nums font-semibold " + (isOverdue ? "text-bad" : "text-ink")}>
                      ฿{formatSatang(row.outstandingSatang)}
                    </span>
                  </div>
                  <span className="break-words text-xs text-ink-muted">{row.item}</span>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="inline-block w-fit truncate rounded-full border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-muted">
                      {categoryChipLabel(row)}
                    </span>
                    {apRowPhotoCount(row.photos) !== null && (
                      <span className="inline-block w-fit truncate rounded-full border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-muted">
                        {AP_FIELDS.photoCount(apRowPhotoCount(row.photos)!)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-muted">
                      {row.dueDate ? isoToBuddhist(row.dueDate) : EMPTY_VALUE}
                    </span>
                    {isSettled ? (
                      <span className="text-xs font-medium text-ok">
                        {/* H3 fix — see the desktop grid's identical guard above. */}
                        {AP_STATUS.settledOn(row.settledAt ? isoToBuddhist(row.settledAt) : EMPTY_VALUE)}
                      </span>
                    ) : (
                      <span
                        className={"inline-block rounded-full border bg-panel px-2 py-0.5 text-xs font-medium " + statusChipClasses(status)}
                      >
                        {statusLabel(status)}
                      </span>
                    )}
                  </div>
                  {!isSettled && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPayingRowId(row.id);
                      }}
                      className="mt-1 flex h-11 items-center justify-center rounded-md border border-line-strong bg-panel text-sm font-semibold text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    >
                      {AP_PAY.action}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {drawerMode && (
        <ApRowDrawer
          row={editingRow}
          creditors={data?.creditors ?? []}
          onClose={closeDrawer}
          onSaved={() => {
            closeDrawer();
            void fetchRows();
          }}
          onDeleted={() => {
            closeDrawer();
            void fetchRows();
          }}
          onPaymentChanged={() => void fetchRows()}
        />
      )}

      {payingRow && (
        <ApPaymentForm
          row={payingRow}
          onClose={() => setPayingRowId(null)}
          onPosted={() => {
            const id = payingRow.id;
            setPayingRowId(null);
            void fetchRows().then(() => flash(id));
          }}
        />
      )}
    </div>
  );
}
