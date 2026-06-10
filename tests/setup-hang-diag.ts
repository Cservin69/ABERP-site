import { armHangDiag } from './hang-diag';

// Vitest setupFiles — runs inside each test worker. Covers the other half of
// the hypothesis: that it's a worker, not the main process, holding a handle
// open and stalling the pool teardown the main process is waiting on.
armHangDiag('WORKER');
