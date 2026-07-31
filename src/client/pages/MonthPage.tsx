import { useEffect, useMemo, useState } from "react";
import { SessionExpiredError, getMonthExpenses } from "../api.ts";
import { navigate } from "../App.tsx";
import {
  EXPENSE_CATEGORIES,
  RECURRING_CATEGORY_CODES,
  RECURRING_CATEGORY_COUNT,
  categoryByCode,
  type ExpenseCategoryCode,
} from "../../shared/categories.ts";
import { currentMonthBangkok, isoToBuddhist, monthToThaiLong, shiftMonths } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import type { ExpenseTransaction, MonthExpensesResponse } from "../../shared/types.ts";
import { EditDrawer } from "../components/EditDrawer.tsx";
import { PhotoLightbox } from "../components/PhotoLightbox.tsx";
import {
  CHECKLIST,
  EMPTY_MONTH,
  EMPTY_VALUE,
  FIELD_LABELS,
  ITEM_LIST,
  LOADING,
  MONTH_HEADER,
  PAYMENT_METHOD_LABELS,
  TOTALS,
  loadFailedDetail,
} from "../labels.ts";
import { loadRecentCategories } from "../storage.ts";

interface Props {
  month: string;
}

/** Screen 2 — สรุปเดือน (frontend spec §3): the recurring checklist, the
 * category totals reconciliation surface, then the itemized list. */
export function MonthPage({ month }: Props) {
  const [data, setData] = useState<MonthExpensesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<ExpenseCategoryCode | null>(null);
  const [editingItem, setEditingItem] = useState<ExpenseTransaction | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const recentCodes = useMemo(() => loadRecentCategories(), []);

  function fetchMonth() {
    return getMonthExpenses(month)
      .then((res) => setData(res))
      .catch((err) => {
        if (err instanceof SessionExpiredError) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }

  useEffect(() => {
    setData(null);
    setLoadError(null);
    setFilterCategory(null);
    void fetchMonth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const monthLabel = monthToThaiLong(month);
  const isCurrentMonth = month === currentMonthBangkok();

  const recurringStatus = useMemo(() => {
    if (!data) return null;
    return RECURRING_CATEGORY_CODES.map((code) => ({
      code,
      items: data.items.filter((i) => i.categoryCode === code),
    }));
  }, [data]);
  const checklistDoneCount = recurringStatus?.filter((r) => r.items.length > 0).length ?? 0;

  const visibleItems = useMemo(() => {
    if (!data) return [];
    return filterCategory ? data.items.filter((i) => i.categoryCode === filterCategory) : data.items;
  }, [data, filterCategory]);

  const itemListColumns = "grid-cols-[6rem_9rem_1fr_5rem_7rem_3rem_8rem]";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => navigate(`/month/${shiftMonths(month, -1)}`)}
            aria-label={MONTH_HEADER.prevMonth}
            className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            ‹
          </button>
          <span className="text-sm font-semibold text-ink">{monthLabel}</span>
          <button
            type="button"
            onClick={() => navigate(`/month/${shiftMonths(month, 1)}`)}
            aria-label={MONTH_HEADER.nextMonth}
            className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            ›
          </button>
          {!isCurrentMonth && (
            <button
              type="button"
              onClick={() => navigate(`/month/${currentMonthBangkok()}`)}
              className="ml-1 text-xs font-medium text-brand-500 hover:underline"
            >
              {MONTH_HEADER.backToCurrent}
            </button>
          )}
        </div>
        {data && (
          <span className="text-base font-bold tabular-nums text-ink">
            {MONTH_HEADER.total} ฿{formatSatang(data.totalSatang)}
          </span>
        )}
      </div>

      {loadError && (
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">{loadFailedDetail(loadError)}</div>
      )}
      {!loadError && data === null && <div className="p-6 text-sm text-ink-muted">{LOADING}</div>}

      {!loadError && data !== null && data.items.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink-muted">
          <span>{EMPTY_MONTH.message}</span>
          <button
            type="button"
            onClick={() => navigate("/entry")}
            className="rounded-md bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600"
          >
            {EMPTY_MONTH.cta}
          </button>
        </div>
      )}

      {!loadError && data !== null && (
        <>
          {/* §3.1 รายการที่ต้องมีทุกเดือน — first on the page, always rendered
              (even at zero entries: all 17 rows read "missing", which is
              informative on day one, not an error). */}
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <h2 className="text-sm font-semibold text-ink">{CHECKLIST.heading}</h2>
              <span className="text-xs font-semibold text-ink-muted">
                {CHECKLIST.progress(checklistDoneCount, RECURRING_CATEGORY_COUNT)}
              </span>
            </div>
            <div className="grid grid-cols-1 divide-y divide-line lg:grid-cols-2 lg:divide-y-0">
              {recurringStatus!.map(({ code, items }, index) => {
                const category = categoryByCode(code);
                const entered = items.length > 0;
                const amountSum = items.reduce((sum, i) => sum + i.amountSatang, 0);
                return (
                  <div
                    key={code}
                    className={
                      "flex items-center justify-between gap-3 px-4 py-2.5 text-sm lg:border-b lg:border-line " +
                      (index % 2 === 0 ? "lg:border-r" : "")
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={"h-2 w-2 shrink-0 rounded-full " + (entered ? "bg-ok" : "bg-warn")}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 truncate text-ink">
                        {category.label}
                        {category.building ? ` (${category.building})` : ""}
                      </span>
                    </span>
                    {entered ? (
                      <span className="shrink-0 text-right text-xs">
                        <span className="font-medium text-ok">฿{formatSatang(amountSum)}</span>
                        <span className="text-ink-muted">
                          {" · "}
                          {items.length > 1 ? CHECKLIST.countItems(items.length) : isoToBuddhist(items[0]!.date)}
                        </span>
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs font-medium text-warn">{CHECKLIST.missing}</span>
                        <button
                          type="button"
                          onClick={() => navigate(`/entry?cat=${code}`)}
                          className="rounded-md border border-line-strong px-2 py-1 text-xs font-medium text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                        >
                          {CHECKLIST.record}
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* §3.2 รวมตามหมวด — the reconciliation surface. All 21 leaves,
              paper-sheet order; a leaf with no entries reads "-", never
              "0.00". Clicking a row filters §3.3; clicking again clears it. */}
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="grid grid-cols-[1fr_7rem_9rem] gap-2 border-b border-line bg-tint px-4 py-2 text-xs font-semibold text-ink-muted">
              <span>{TOTALS.category}</span>
              <span className="text-right">{TOTALS.count}</span>
              <span className="text-right">{TOTALS.total}</span>
            </div>
            <div className="divide-y divide-line">
              {EXPENSE_CATEGORIES.map((category) => {
                const totals = data.totalsByCategory[category.code];
                const selected = filterCategory === category.code;
                return (
                  <button
                    key={category.code}
                    type="button"
                    onClick={() => setFilterCategory((prev) => (prev === category.code ? null : category.code))}
                    aria-pressed={selected}
                    className={
                      "grid w-full grid-cols-[1fr_7rem_9rem] gap-2 px-4 py-2 text-left text-sm hover:bg-tint focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40 " +
                      (selected ? "bg-tint" : "")
                    }
                  >
                    <span className="min-w-0 truncate text-ink">
                      {category.label}
                      {category.building ? ` (${category.building})` : ""}
                    </span>
                    <span className="text-right tabular-nums text-ink">{totals ? totals.count : EMPTY_VALUE}</span>
                    <span className="text-right tabular-nums text-ink">
                      {totals ? formatSatang(totals.amountSatang) : EMPTY_VALUE}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-line-strong bg-tint px-4 py-2.5 text-sm font-semibold text-ink">
              <span>{TOTALS.grandTotal}</span>
              <span className="tabular-nums">{formatSatang(data.totalSatang)}</span>
            </div>
          </section>

          {/* §3.3 รายการทั้งหมด — itemized list, already sorted วันที่ desc
              then insertion desc by the server. */}
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="border-b border-line px-4 py-2.5">
              <h2 className="text-sm font-semibold text-ink">{ITEM_LIST.heading}</h2>
            </div>
            <div className={"grid gap-2 border-b border-line bg-tint px-4 py-2 text-xs font-semibold text-ink-muted " + itemListColumns}>
              <span>{ITEM_LIST.date}</span>
              <span>{TOTALS.category}</span>
              <span>{FIELD_LABELS.item}</span>
              <span>{ITEM_LIST.paymentMethod}</span>
              <span className="text-right">{FIELD_LABELS.amount}</span>
              <span>{ITEM_LIST.photo}</span>
              <span>{ITEM_LIST.recordedBy}</span>
            </div>
            {visibleItems.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">{EMPTY_MONTH.message}</p>
            ) : (
              <div className="divide-y divide-line">
                {visibleItems.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setEditingItem(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditingItem(item);
                      }
                    }}
                    className={
                      "grid cursor-pointer items-center gap-2 px-4 py-2 text-sm hover:bg-tint focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40 " +
                      itemListColumns
                    }
                  >
                    <span className="tabular-nums text-ink">{isoToBuddhist(item.date)}</span>
                    <span className="min-w-0 truncate text-ink">{categoryByCode(item.categoryCode).label}</span>
                    <span className="min-w-0 truncate text-ink" title={item.comment}>
                      {item.comment || EMPTY_VALUE}
                    </span>
                    <span className="text-ink-muted">{PAYMENT_METHOD_LABELS[item.paymentMethod]}</span>
                    <span className="text-right tabular-nums text-ink">{formatSatang(item.amountSatang)}</span>
                    <span>
                      {item.photos[0] ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLightboxUrl(item.photos[0]!.url);
                          }}
                          className="block"
                        >
                          <img src={item.photos[0].url} alt="" className="h-10 w-10 rounded-md border border-line object-cover" />
                        </button>
                      ) : (
                        <span className="text-ink-muted">{EMPTY_VALUE}</span>
                      )}
                    </span>
                    <span className="min-w-0 truncate text-xs text-ink-muted">
                      {item.by ? item.by.split("@")[0] : EMPTY_VALUE}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {editingItem && (
        <EditDrawer
          item={editingItem}
          recentCodes={recentCodes}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            void fetchMonth();
          }}
          onDeleted={() => {
            setEditingItem(null);
            void fetchMonth();
          }}
        />
      )}
      {lightboxUrl && <PhotoLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
