export interface GatewayLogger {
  error: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

const write = (
  level: 'error' | 'info' | 'warn',
  message: string,
  fields?: Record<string, unknown>,
) => {
  const entry = JSON.stringify({
    ...(fields ?? {}),
    level,
    message,
    timestamp: new Date().toISOString(),
  });
  process[level === 'info' ? 'stdout' : 'stderr'].write(`${entry}\n`);
};

export const consoleLogger: GatewayLogger = {
  error: (message, fields) => write('error', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
};

export const silentLogger: GatewayLogger = {
  error: () => {},
  info: () => {},
  warn: () => {},
};
