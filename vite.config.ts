import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

// S333 / PR-20: opt-in instrumentation for the CI exit-hang. Loaded ONLY when
// VITEST_HANG_DIAG=1 (set on the deploy.yml Test step) so normal dev/CI runs
// don't even parse the diagnostic files. See tests/hang-diag.ts.
const hangDiag = process.env.VITEST_HANG_DIAG === '1';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		expect: { requireAssertions: true },
		// globalSetup runs in the main vitest process — instruments the process
		// GitHub kills on hang.
		globalSetup: hangDiag ? ['./tests/global-hang-diag.ts'] : [],
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					// setupFiles run inside each worker — instruments the other
					// hang-location hypothesis (a worker, not main, holding a handle).
					setupFiles: hangDiag ? ['./tests/setup-hang-diag.ts'] : [],
					// S315 / PR-15: run in the worker-threads pool, not the default
					// `forks` pool. The CI Test step hung indefinitely *after* all
					// 351 tests passed — the run logged every file as ✓, then never
					// printed a summary or exited, and GitHub cancelled it ~6 min
					// later ("Terminate orphan process ... npm run test:unit"). It
					// reproduced only on the 2-core hosted runner, never locally
					// (macOS/Node 25, nor Node 20.19.4): a process-teardown deadlock
					// in the `forks` pool under worker over-subscription, not a
					// leaked handle in our code (the diff has no timers, watchers,
					// or sockets; the EACCES on `/home/aberp` is caught by
					// `enqueueSafe` and the tests pass through it). The `threads`
					// pool tears down via `worker.terminate()` with no child-process
					// exit handshake to deadlock on, so this class of hang cannot
					// recur. Our specs never mutate shared process state across
					// files — each sets its own tmpdir/env before a dynamic import —
					// so dropping subprocess isolation is safe. Fallback if this
					// regresses: `pool: 'forks'` + `poolOptions.forks.singleFork`.
					pool: 'threads',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
