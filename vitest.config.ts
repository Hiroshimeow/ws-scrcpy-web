import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // CSS imports are stubbed out (no stylesheet processing needed in tests)
        css: false,
    },
});
