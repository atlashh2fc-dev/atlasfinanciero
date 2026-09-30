"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { costCenterDepth, costCenterGroupKey, costCenterGroupName, nextChildCostCenterCode, nextRootCostCenterCode } from "@/lib/cost-center-codes";

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
  /** Con ambos, el popover permite crear un centro sin salir del formulario. */
  organizationId?: string | null;
  onCreated?: (center: CostCenterOption) => void;
};

function groupCenters(centers: CostCenterOption[]) {
  const values = new Map<string, CostCenterOption[]>();
  for (const center of centers) {
    const key = costCenterGroupKey(center.code);
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
      return { key, name: costCenterGroupName(key, sorted), centers: sorted };
    });
}

export function CostCenterPicker({
  centers,
  value,
  onChange,
  required = false,
  disabled = false,
  organizationId = null,
  onCreated,
}: Props) {
  const canCreate = Boolean(organizationId && onCreated);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [draft, setDraft] = useState<{ parentId: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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
    const selectedGroup = selected ? costCenterGroupKey(selected.code) : undefined;
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
    setDraft(null);
    setOpen(false);
  }

  const sortedCenters = useMemo(
    () =>
      [...centers].sort((left, right) =>
        left.code.localeCompare(right.code, "es", { numeric: true }),
      ),
    [centers],
  );
  const draftParent = sortedCenters.find((center) => center.id === draft?.parentId) ?? null;
  // Mismo cálculo que en Centros de costo: el nuevo centro queda anidado.
  const draftCode = useMemo(() => {
    const codes = sortedCenters.map((center) => center.code);
    return draftParent
      ? nextChildCostCenterCode(draftParent.code, codes)
      : nextRootCostCenterCode(codes);
  }, [sortedCenters, draftParent]);

  async function createCenter() {
    if (!draft || !organizationId || !onCreated || creating) return;
    const name = draft.name.trim();
    if (!name) {
      setCreateError("Escribe el nombre del centro.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/cost-centers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, action: "create_center", code: draftCode, name }),
    });
    const payload = (await response.json().catch(() => null)) as {
      center?: CostCenterOption;
      error?: string;
    } | null;
    setCreating(false);
    if (!response.ok || !payload?.center) {
      setCreateError(
        payload?.error === "duplicate_center_code"
          ? "Ese código ya existe. Vuelve a intentarlo."
          : "No se pudo crear el centro. Verifica tus permisos.",
      );
      return;
    }
    onCreated(payload.center);
    selectCenter(payload.center);
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
                          style={{
                            paddingLeft: `${9 + (costCenterDepth(center.code) - 1) * 12}px`,
                          }}
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
                {centers.length
                  ? "No encontramos centros con esa búsqueda."
                  : "Aún no hay centros de costo."}
              </p>
            )}
          </div>
          {canCreate && !draft && (
            <button
              type="button"
              className="p2p-cost-center-create-toggle"
              onClick={() => {
                setDraft({ parentId: "", name: search.trim() });
                setCreateError(null);
              }}
            >
              + Crear centro de costo{search.trim() ? ` «${search.trim()}»` : ""}
            </button>
          )}
          {canCreate && draft && (
            <div className="p2p-cost-center-create" role="group" aria-label="Crear centro de costo">
              <label>
                Depende de
                <select
                  value={draft.parentId}
                  onChange={(event) => setDraft({ ...draft, parentId: event.target.value })}
                >
                  <option value="">Ninguno · grupo principal nuevo</option>
                  {sortedCenters.map((center) => (
                    <option key={center.id} value={center.id}>
                      {"\u00a0\u00a0".repeat(costCenterDepth(center.code) - 1)}
                      {center.code} · {center.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Nombre *
                <input
                  autoFocus
                  value={draft.name}
                  maxLength={160}
                  placeholder={draftParent ? "Subcentro, proyecto o gasto" : "Área o grupo"}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  onKeyDown={(event) => {
                    // Está dentro del formulario del gasto: Enter crea el
                    // centro en vez de enviar el formulario completo.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createCenter();
                    }
                  }}
                />
              </label>
              <small>Código {draftCode}</small>
              {createError && <small className="p2p-cost-center-create-error" role="alert">{createError}</small>}
              <div className="p2p-cost-center-create-actions">
                <button type="button" className="secondary-button" onClick={() => setDraft(null)}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={creating || !draft.name.trim()}
                  onClick={() => void createCenter()}
                >
                  {creating ? "Creando…" : "Crear y seleccionar"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
