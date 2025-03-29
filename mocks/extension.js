// Mock extension module for tests
module.exports = {
    // Mock logger for tests
    logger: {
        log: (message, level = 1) => {
            // Just log to console during tests
            console.log(`[TEST LOG] ${message}`);
        },
        init: () => {}
    }
}; 