const sessionMutationLocks = new Map<string, Promise<void>>();

export async function withSessionMutationLock<T>(
  sessionId: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const key = sessionId.trim();
  if (key.length === 0) {
    return await run();
  }

  const previous = sessionMutationLocks.get(key);
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  sessionMutationLocks.set(key, current);

  try {
    await previous;
    return await run();
  } finally {
    if (sessionMutationLocks.get(key) === current) {
      sessionMutationLocks.delete(key);
    }
    releaseCurrent();
  }
}
