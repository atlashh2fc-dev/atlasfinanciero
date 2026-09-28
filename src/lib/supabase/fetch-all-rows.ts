// PostgREST corta silenciosamente cada respuesta en `max_rows` (1000 en este
// proyecto). Para listados que deben estar completos se pide página por página
// con `.range()` hasta recibir una página incompleta. La consulta debe tener un
// orden estable (incluir una columna única como `id`) para no saltar filas.
export const SUPABASE_PAGE_SIZE = 1_000;

type PageResult<Row, Err> = { data: Row[] | null; error: Err | null };

export async function fetchAllRows<Row, Err>(
  page: (from: number, to: number) => PromiseLike<PageResult<Row, Err>>,
  pageSize = SUPABASE_PAGE_SIZE,
): Promise<PageResult<Row, Err>> {
  const rows: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}
