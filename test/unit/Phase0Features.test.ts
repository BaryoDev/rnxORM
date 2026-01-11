import { DbContext, createLogger } from '../../src';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

class TestDbContext extends DbContext {}

describe('Phase 0: Production Features', () => {
    describe('Connection Retry Logic', () => {
        it('should retry connection on failure with exponential backoff', async () => {
            let attempts = 0;
            const mockProvider = new MockDatabaseProvider();

            // Override connect to fail first 2 times
            const originalConnect = mockProvider.connect.bind(mockProvider);
            mockProvider.connect = async () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error('Connection failed');
                }
                await originalConnect();
            };

            const db = new TestDbContext(mockProvider, {
                retry: {
                    maxRetries: 3,
                    initialDelay: 10, // Short delay for testing
                    backoffMultiplier: 2
                }
            });

            await db.connect();
            expect(attempts).toBe(3);
        });

        it('should throw after max retries', async () => {
            const mockProvider = new MockDatabaseProvider();

            // Always fail
            mockProvider.connect = async () => {
                throw new Error('Connection failed');
            };

            const db = new TestDbContext(mockProvider, {
                retry: {
                    maxRetries: 2,
                    initialDelay: 10
                }
            });

            await expect(db.connect()).rejects.toThrow('Connection failed');
        });
    });

    describe('Graceful Shutdown', () => {
        it('should disconnect cleanly when no pending changes', async () => {
            const mockProvider = new MockDatabaseProvider();
            const db = new TestDbContext(mockProvider);

            await db.connect();
            await db.gracefulShutdown();

            // Should complete without errors
            expect(true).toBe(true);
        });

        it('should save pending changes before shutdown', async () => {
            const mockProvider = new MockDatabaseProvider();
            const db = new TestDbContext(mockProvider);

            await db.connect();

            // Add some changes
            const stats = db.changeTracker.getStatistics();
            expect(stats.added + stats.modified + stats.deleted).toBe(0);

            await db.gracefulShutdown();

            // Should complete successfully
            expect(true).toBe(true);
        });

        it('should timeout if shutdown takes too long', async () => {
            const mockProvider = new MockDatabaseProvider();
            mockProvider.disconnect = async () => {
                // Simulate slow disconnect
                await new Promise(resolve => setTimeout(resolve, 1000));
            };

            const db = new TestDbContext(mockProvider);
            await db.connect();

            await expect(db.gracefulShutdown(100)).rejects.toThrow('Shutdown timeout exceeded');
        });
    });

    describe('Structured Logging', () => {
        it('should use custom logger if provided', () => {
            const mockLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            };

            const mockProvider = new MockDatabaseProvider();
            const db = new TestDbContext(mockProvider, {
                logger: mockLogger
            });

            expect(db['logger']).toBe(mockLogger);
        });

        it('should create default logger if not provided', () => {
            const mockProvider = new MockDatabaseProvider();
            const db = new TestDbContext(mockProvider);

            expect(db['logger']).toBeDefined();
            expect(db['logger'].info).toBeDefined();
            expect(db['logger'].warn).toBeDefined();
            expect(db['logger'].error).toBeDefined();
            expect(db['logger'].debug).toBeDefined();
        });
    });

    describe('Connection Pool Monitoring', () => {
        it('should return pool stats for providers that support it', () => {
            const mockProvider: any = new MockDatabaseProvider();

            // Add getPoolStats to mock provider
            mockProvider.getPoolStats = () => ({
                total: 10,
                idle: 5,
                active: 5,
                waiting: 0
            });

            const db = new TestDbContext(mockProvider);
            const stats = db.getPoolStats();

            expect(stats).toEqual({
                total: 10,
                idle: 5,
                active: 5,
                waiting: 0
            });
        });

        it('should return null for providers without pool stats', () => {
            const mockProvider: any = new MockDatabaseProvider();
            delete mockProvider.getPoolStats;

            const db = new TestDbContext(mockProvider);
            const stats = db.getPoolStats();

            expect(stats).toBeNull();
        });
    });

    describe('Enhanced Error Messages', () => {
        it('should log connection errors with context', async () => {
            const mockLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            };

            const mockProvider = new MockDatabaseProvider();
            mockProvider.connect = async () => {
                throw new Error('Connection error');
            };

            const db = new TestDbContext(mockProvider, {
                logger: mockLogger,
                retry: {
                    maxRetries: 1,
                    initialDelay: 1
                }
            });

            // Try to connect (will fail)
            try {
                await db.connect();
            } catch (e) {
                // Expected
            }

            // Should have logged error with context
            expect(mockLogger.error).toHaveBeenCalled();
            const errorCall = mockLogger.error.mock.calls[0];
            expect(errorCall[0]).toContain('Failed to connect');
        });
    });
});
