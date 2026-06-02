// Pure decision logic for whether to render the WebGL rain or the CSS-gradient fallback.
// Lives in its own module so it can be unit-tested without a DOM.

export type FallbackReason = 'reduced-motion' | 'save-data' | 'tiny-viewport';

export interface FallbackEnv {
	reducedMotion: boolean;
	saveData: boolean;
	innerWidth: number;
}

export interface FallbackDecision {
	fallback: boolean;
	reason?: FallbackReason;
}

const TINY_VIEWPORT_PX = 480;

export function decideRainFallback(env: FallbackEnv): FallbackDecision {
	if (env.reducedMotion) return { fallback: true, reason: 'reduced-motion' };
	if (env.saveData) return { fallback: true, reason: 'save-data' };
	if (env.innerWidth < TINY_VIEWPORT_PX) return { fallback: true, reason: 'tiny-viewport' };
	return { fallback: false };
}
