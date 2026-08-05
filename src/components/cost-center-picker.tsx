"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type CostCenterOption = {
  id: string;
  code: string;
  name: string;
};

type Props = {
  centers: CostCenterOption[];
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
};

function groupCenters(centers: CostCenterOption[]) {
  const values = new Map<string, CostCenterOption[]>();
  for (const center of centers) {
    const key = center.code.split(".")[0] || "Otros";
    values.set(key, [...(values.get(key) ?? []), center]);
  }
  return [...values.entries()]
    .sort(([left], [right]) =>
      left.localeCompare(right, "es", { numeric: true }),
    )
    .map(([key, groupedCenters]) => {
      const sorted = [...groupedCenters].sort((left, right) =>
        left.code.localeCompare(right.code, "es", { numeric: true }),
      );
      return {
        key,
        name:
          sorted.find((center) => center.code === `${key}.0.0.0`)?.name ??
          `Grupo ${key}`,
        centers: sorted,
      };
    });
}

export function CostCenterPicker({
  centers,
  value,
  onChange,
  required = false,
  disabled = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const selected = centers.find((center) => center.id === value) ?? null;
  const groups = useMemo(() => groupCenters(centers), [centers]);
  const normalizedSearch = search.trim().toLocaleLowerCase("es-CL");
  const visibleGroups = useMemo(
    () =>
      normalizedSearch
        ? groups
            .map((group) => ({
              ...group,
              centers: group.centers.filter((center) =>
                `${center.code} ${center.name}`
                  .toLocaleLowerCase("es-CL")
                  .includes(normalizedSearch),
              ),
            }))
            .filter((group) => group.centers.length)
        : groups,
    [groups, normalizedSearch],
  );

  useEffect(() => {
    if (!open) return;
    const selectedGroup = selected?.code.split(".")[0];
    if (selectedGroup)
      setExpandedGroups((current) =>
        current.includes(selectedGroup) ? current : [...current, selectedGroup],
      );
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, selected?.code]);

  function selectCenter(center: CostCenterOption) {
    onChange(center.id);
    setSearch("");
    setOpen(false);
  }

  return (
    <div className="p2p-cost-center-field" ref={rootRef}>
      <span className="p2p-cost-center-label">
        Centro de costo {required && "*"}
      </span>
      <button
        type="button"
        className={`p2p-cost-center-trigger${open ? " is-open" : ""}`}
        aria-label="Seleccionar centro de costo"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required={required}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected ? "" : "is-placeholder"}>
          {selected
            ? `${selected.code} · ${selected.name}`
            : "Selecciona un centro"}
        </span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div
          className="p2p-cost-center-popover"
          role="dialog"
          aria-label="Centros de costo agrupados"
        >
          <div className="p2p-cost-center-search">
            <input
              ref={searchRef}
              type="search"
              value={search}
              placeholder="Buscar por código o nombre…"
              aria-label="Buscar centro de costo"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="p2p-cost-center-groups">
            {visibleGroups.map((group) => {
              const expanded =
                Boolean(normalizedSearch) || expandedGroups.includes(group.key);
              return (
                <section className="p2p-cost-center-group" key={group.key}>
                  <button
                    type="button"
                    className="p2p-cost-center-group-toggle"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedGroups((current) =>
                        current.includes(group.key)
                          ? current.filter((key) => key !== group.key)
                          : [...current, group.key],
                      )
                    }
                  >
                    <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    <strong>
                      {group.key} · {group.name}
                    </strong>
                    <small>{group.centers.length}</small>
                  </button>
                  {expanded && (
                    <div className="p2p-cost-center-options">
                      {group.centers.map((center) => (
                        <button
                          type="button"
                          key={center.id}
                          className={center.id === value ? "is-selected" : ""}
                          aria-current={center.id === value ? "true" : undefined}
                          onClick={() => selectCenter(center)}
                        >
                          <strong>{center.code}</strong>
                          <span>{center.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
            {!visibleGroups.length && (
              <p className="p2p-cost-center-empty">
                No encontramos centros con esa búsqueda.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
