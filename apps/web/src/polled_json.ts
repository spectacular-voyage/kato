export type PolledJsonLoadResult<T> =
  | { kind: "data"; data: T }
  | { kind: "unchanged" }
  | { kind: "unauthorized" };

export async function loadPolledJson<T>(options: {
  endpoint: string;
  fetchFn?: typeof fetch;
}): Promise<PolledJsonLoadResult<T>> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(options.endpoint, {
    cache: "no-store",
  });

  if (response.status === 401) {
    response.body?.cancel();
    return { kind: "unauthorized" };
  }
  if (!response.ok) {
    response.body?.cancel();
    return { kind: "unchanged" };
  }

  return {
    kind: "data",
    data: await response.json() as T,
  };
}
