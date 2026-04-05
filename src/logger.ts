function emit(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: unknown): void {
  const payload =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? { level, timestamp: new Date().toISOString(), message, ...(meta as Record<string, unknown>) }
      : { level, timestamp: new Date().toISOString(), message, meta };

  const line = JSON.stringify(payload);
  if (level === 'ERROR') {
    console.error(line);
    return;
  }
  if (level === 'WARN') {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function logInfo(message: string, meta?: unknown): void {
  emit('INFO', message, meta);
}

export function logWarn(message: string, meta?: unknown): void {
  emit('WARN', message, meta);
}

export function logError(message: string, meta?: unknown): void {
  emit('ERROR', message, meta);
}
