import pino from 'pino';

/**
 * Logger interface for structured logging
 */
export interface Logger {
    info(message: string, meta?: object): void;
    warn(message: string, meta?: object): void;
    error(message: string, error?: Error, meta?: object): void;
    debug(message: string, meta?: object): void;
}

/**
 * Logger options
 */
export interface LoggerOptions {
    level?: 'debug' | 'info' | 'warn' | 'error';
    pretty?: boolean;
    name?: string;
}

/**
 * Create a structured logger instance
 */
export function createLogger(options?: LoggerOptions): Logger {
    const logger = pino({
        level: options?.level || process.env.LOG_LEVEL || 'info',
        name: options?.name || 'rnxorm',
        transport: options?.pretty !== false && process.env.NODE_ENV === 'development' ? {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname'
            }
        } : undefined
    });

    return {
        info: (msg, meta) => logger.info(meta || {}, msg),
        warn: (msg, meta) => logger.warn(meta || {}, msg),
        error: (msg, error, meta) => logger.error({ err: error, ...meta }, msg),
        debug: (msg, meta) => logger.debug(meta || {}, msg)
    };
}

/**
 * Console logger implementation (fallback)
 */
export class ConsoleLogger implements Logger {
    info(message: string, meta?: object): void {
        console.log(`[INFO] ${message}`, meta || '');
    }

    warn(message: string, meta?: object): void {
        console.warn(`[WARN] ${message}`, meta || '');
    }

    error(message: string, error?: Error, meta?: object): void {
        console.error(`[ERROR] ${message}`, error || '', meta || '');
    }

    debug(message: string, meta?: object): void {
        console.debug(`[DEBUG] ${message}`, meta || '');
    }
}
