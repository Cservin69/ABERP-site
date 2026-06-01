import { env } from '$env/dynamic/private';
import { error, redirect, type Cookies } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'aberp_site_admin';

function getConfiguredToken(): string {
	const token = env.ABERP_SITE_ADMIN_TOKEN;
	if (!token || token.length === 0) {
		throw error(503, 'Server is not configured: ABERP_SITE_ADMIN_TOKEN required.');
	}
	return token;
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * Validates a Bearer-token Authorization header against ABERP_SITE_ADMIN_TOKEN.
 * Throws 503 if the env var is not set (refuse-to-start posture).
 * Throws 401 if the header is missing or wrong.
 */
export function requireAdminAuth(request: Request): void {
	const expected = getConfiguredToken();
	const header = request.headers.get('authorization');
	if (!header) throw error(401, 'Unauthorized');
	const prefix = 'Bearer ';
	if (!header.startsWith(prefix)) throw error(401, 'Unauthorized');
	const presented = header.slice(prefix.length);
	if (!safeEqual(presented, expected)) throw error(401, 'Unauthorized');
}

/**
 * Validates the admin cookie. Returns true on match.
 * Throws 503 if the env var is not set.
 */
export function hasValidAdminCookie(cookies: Cookies): boolean {
	const expected = getConfiguredToken();
	const presented = cookies.get(ADMIN_COOKIE);
	if (!presented) return false;
	return safeEqual(presented, expected);
}

/**
 * Used by /admin/* layout server loads. Redirects to /admin/login if no valid cookie.
 * Throws 503 if env unset.
 *
 * IMPORTANT: SvelteKit runs `+page.server.ts` actions **before** any parent
 * layout's server `load`. This helper therefore does NOT protect form actions —
 * the layout guard has not run yet at action time. Every `actions = { … }`
 * export under /admin/* (excluding login) MUST call
 * `requireAdminCookieOrError(cookies)` at the top of the handler instead.
 */
export function requireAdminCookieOrRedirect(cookies: Cookies, currentPath: string): void {
	if (!hasValidAdminCookie(cookies)) {
		const target =
			currentPath && currentPath !== '/admin/login'
				? `?next=${encodeURIComponent(currentPath)}`
				: '';
		throw redirect(303, `/admin/login${target}`);
	}
}

/**
 * Form-action variant of `requireAdminCookieOrRedirect`. Throws `error(401)`
 * instead of redirecting. Use this at the top of every `+page.server.ts`
 * `actions = { … }` handler under /admin/* (excluding the login action
 * itself, which establishes the cookie, and logout, which is idempotent).
 * Redirecting from a form action would 303 the request back to /admin/login
 * with no signal in the response body, so direct-POST attackers get the
 * misleading appearance of success; the 401 makes the failure explicit.
 */
export function requireAdminCookieOrError(cookies: Cookies): void {
	if (!hasValidAdminCookie(cookies)) {
		throw error(401, 'Unauthorized');
	}
}

/**
 * Checks the submitted password against ABERP_SITE_ADMIN_TOKEN.
 * Returns true on match. Throws 503 if env unset.
 */
export function checkLogin(submitted: string): boolean {
	const expected = getConfiguredToken();
	return safeEqual(submitted, expected);
}

/**
 * Sets the admin auth cookie. The cookie value is the same as the token,
 * since both browser-cookie and server-bearer auth are gated on the same secret.
 */
export function setAdminCookie(cookies: Cookies, token: string, secure: boolean): void {
	cookies.set(ADMIN_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure,
		maxAge: 60 * 60 * 12
	});
}

export function clearAdminCookie(cookies: Cookies): void {
	cookies.delete(ADMIN_COOKIE, { path: '/' });
}
