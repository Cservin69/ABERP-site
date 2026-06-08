import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { isVitest, runBootChecks, type BootCheckResult } from '$lib/server/boot-checks';

const SECRET_HEADER = 'x-cloudfront-secret';
let bootVerdict: BootCheckResult | null = null;
let bootLogged = false;

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * CloudFront → Lightsail shared-header check.
 *
 * When CLOUDFRONT_SHARED_SECRET is set, every request must carry an
 * `X-CloudFront-Secret` header matching it. CloudFront is configured to add
 * the header to every origin request (see docs/aws/cloudfront-behaviors.md
 * "Custom headers"), so legitimate traffic always passes; direct hits to the
 * Lightsail static IP from random scanners fail with 403.
 *
 * `/healthz` is exempt — it's the endpoint the post-deploy health probe in
 * bin/lightsail-deploy.sh curls, and the body intentionally reveals nothing
 * beyond "the server is up". Localhost-skip is NOT used here because nginx
 * (when present in front) makes every request look local at the socket layer.
 *
 * When CLOUDFRONT_SHARED_SECRET is unset (local dev, tests), the check is
 * skipped entirely.
 */
function runBootChecksOnce(): BootCheckResult {
	if (bootVerdict !== null) return bootVerdict;
	bootVerdict = runBootChecks();
	if (!bootVerdict.ok && !bootLogged) {
		bootLogged = true;
		for (const p of bootVerdict.problems) {
			console.error(`[boot-check ${p.finding}] ${p.message}`);
		}
	}
	return bootVerdict;
}

export const handle: Handle = async ({ event, resolve }) => {
	const verdict = runBootChecksOnce();
	if (event.url.pathname === '/healthz') {
		return new Response('ok\n', {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
		});
	}
	// Refuse-to-start surfaces as 503 on every non-healthz request so the
	// problem is visible without a process crash — adapter-node has no clean
	// boot/serve separation. Vitest is exempt because tests legitimately do
	// not set every prod env; SvelteKit's prerender pass (`building`) is also
	// exempt because the build happens in CI with no relay/operator config
	// set, and we don't want the prerender 503 to fail the build. The
	// boot-checks module's pure `runBootChecks` is what unit tests verify
	// (boot-checks.spec.ts).
	if (!verdict.ok && !isVitest() && !building) {
		const summary = verdict.problems.map((p) => `${p.finding}: ${p.message}`).join('\n\n');
		return new Response(`service unavailable: storefront boot checks failed.\n\n${summary}\n`, {
			status: 503,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
		});
	}
	const expected = env.CLOUDFRONT_SHARED_SECRET;
	if (expected && expected.length > 0) {
		const presented = event.request.headers.get(SECRET_HEADER) ?? '';
		if (!safeEqual(presented, expected)) {
			return new Response('forbidden: missing origin signature', { status: 403 });
		}
	}
	return resolve(event);
};
