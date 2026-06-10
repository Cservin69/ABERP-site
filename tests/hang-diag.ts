// Diagnostic harness for the vitest CI exit-hang (S333 / PR-20).
//
// The `Test` step on the 2-core GitHub-hosted runner prints every spec as ✓ in
// ~3s, then emits nothing until GitHub kills it at the 5-min `timeout-minutes`
// cap: a leaked handle keeps the Node process alive past test completion. It
// reproduces ONLY on the runner (never locally on macOS Node 25 or standalone
// Linux Node 20), and is pool-independent — `forks` (PR-14) and `threads`
// (PR-15) both hang. Three sessions of guess-and-patch (S313/S315/S331) failed
// because we never had ground-truth on WHICH handle is held open. This module
// makes Node itself name it.
//
// Activated ONLY when VITEST_HANG_DIAG=1 — the vitest config skips loading these
// files entirely otherwise, so default dev/CI runs are completely untouched.
//
// Mechanism: an UNREF'd interval. An unref'd timer cannot by itself keep the
// event loop alive, so a clean run exits before it ever fires. It fires only
// while SOMETHING ELSE holds the loop open past test completion — exactly the
// leak we're hunting. Note we deliberately do NOT use `process.on('beforeExit')`
// or `'exit'`: both fire only when the loop is draining / the process is
// actually leaving, neither of which happens during the hang, so both would
// stay silent. The interval, by contrast, keeps reporting for as long as the
// process is wrongly alive. Each tick dumps the active-resource type list
// (cheap), and at a few checkpoints also the full handle stacks via
// why-is-node-running (the part that names the source).
import whyIsNodeRunning from 'why-is-node-running';

export function armHangDiag(role: string): void {
	if (process.env.VITEST_HANG_DIAG !== '1') return;
	// worker_threads each get their own globalThis + event loop, so this guard
	// is per-thread: the main thread arms once as MAIN, each worker once as
	// WORKER, and re-running setupFiles per spec file can't stack intervals.
	const g = globalThis as { __hangDiagArmed?: boolean };
	if (g.__hangDiagArmed) return;
	g.__hangDiagArmed = true;

	const tag = `[hang-diag ${role} pid=${process.pid}]`;
	// Write straight to the fd, not via console.* — vitest intercepts the console
	// to attribute output to tests, which swallowed the worker-side lines in
	// local trials. why-is-node-running takes a Logger, so route it here too.
	const write = (line: string) => process.stderr.write(`${line}\n`);
	const logger = { error: write };

	let ticks = 0;
	const iv = setInterval(() => {
		ticks += 1;
		write(`${tag} tick=${ticks} active=${JSON.stringify(process.getActiveResourcesInfo())}`);
		if (ticks === 2 || ticks === 5 || ticks === 15) {
			write(`${tag} === why-is-node-running (tick ${ticks}) ===`);
			try {
				whyIsNodeRunning(logger);
			} catch (err) {
				write(`${tag} why-is-node-running threw: ${String(err)}`);
			}
		}
	}, 4000);
	iv.unref();
	write(`${tag} armed (unref'd 4s interval; deep handle dumps at ticks 2/5/15 ≈ 8s/20s/60s)`);
}
