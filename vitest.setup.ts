import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { configure } from '@testing-library/react';

// IndexedDB live queries can take longer than the 1s default when all test files run in parallel.
configure({ asyncUtilTimeout: 4000 });
