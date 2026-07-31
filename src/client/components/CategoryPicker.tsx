import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { EXPENSE_CATEGORIES, categoryByCode, type ExpenseCategory, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { CATEGORY_PICKER, FIELD_LABELS } from "../labels.ts";

interface Props {
  value: ExpenseCategoryCode | null;
  onChange: (code: ExpenseCategoryCode) => void;
  recentCodes: ExpenseCategoryCode[];
}

/**
 * The flat 21-tile category grid (frontend spec §2.3). One scrollable
 * container holds, top to bottom: the sticky filter, the ล่าสุด row (hidden
 * on first run), then the 21 tiles in paper-sheet order. `role="radiogroup"`
 * / `role="radio"`; arrow keys move AND change the selection, matching
 * native radiogroup behaviour.
 */
export function CategoryPicker({ value, onChange, recentCodes }: Props) {
  const [filter, setFilter] = useState("");
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo<ExpenseCategory[]>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return [...EXPENSE_CATEGORIES];
    return EXPENSE_CATEGORIES.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.building?.toLowerCase().includes(q) ?? false),
    );
  }, [filter]);

  function selectAndFocus(index: number) {
    const category = filtered[index];
    if (!category) return;
    onChange(category.code);
    tileRefs.current[index]?.focus();
  }

  function handleFilterKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && filtered.length === 1) {
      onChange(filtered[0]!.code);
    }
  }

  function handleGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const currentIndex = Math.max(
      0,
      filtered.findIndex((c) => c.code === value),
    );
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + delta + filtered.length) % filtered.length;
    selectAndFocus(nextIndex);
  }

  return (
    <div
      role="radiogroup"
      aria-label={FIELD_LABELS.category}
      className="max-h-[420px] overflow-y-auto rounded-lg border border-line bg-panel"
    >
      <div className="sticky top-0 z-10 border-b border-line bg-panel p-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleFilterKeyDown}
          placeholder={CATEGORY_PICKER.searchPlaceholder}
          aria-label={CATEGORY_PICKER.searchPlaceholder}
          className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
      </div>

      {recentCodes.length > 0 && (
        <div className="border-b border-line p-2">
          <p className="mb-1.5 text-xs font-semibold text-ink-muted">{CATEGORY_PICKER.recentHeading}</p>
          <div className="flex flex-wrap gap-1.5">
            {recentCodes.map((code) => {
              const category = categoryByCode(code);
              const selected = value === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => onChange(code)}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                    (selected
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-line-strong bg-panel text-ink hover:bg-tint")
                  }
                >
                  {category.label}
                  {category.building ? ` · ${category.building}` : ""}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div
        onKeyDown={handleGridKeyDown}
        className="grid grid-cols-2 gap-2 p-2 lg:grid-cols-3"
      >
        {filtered.map((category, index) => {
          const selected = value === category.code;
          return (
            <button
              key={category.code}
              ref={(el) => {
                tileRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (value === null && index === 0) ? 0 : -1}
              onClick={() => onChange(category.code)}
              className={
                "relative min-h-16 rounded-lg border px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                (selected ? "border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-500" : "border-line bg-panel text-ink")
              }
            >
              {category.building && <span className="absolute inset-y-0 left-0 w-0.5 bg-gold-500" aria-hidden="true" />}
              <span className="block">{category.label}</span>
              {category.building && <span className="mt-0.5 block text-xs text-ink-muted">{category.building}</span>}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-full px-2 py-3 text-center text-sm text-ink-muted">ไม่พบหมวดที่ค้นหา</p>
        )}
      </div>
    </div>
  );
}
