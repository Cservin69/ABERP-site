<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import type { RainInstance } from './rain.ts';
	import { decideRainFallback } from './fallback.ts';

	let canvas: HTMLCanvasElement;
	let rain: RainInstance | null = null;
	let fallback = $state(false);

	onMount(() => {
		if (!browser) return;

		const decision = decideRainFallback({
			reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
			saveData:
				(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
				true,
			innerWidth: window.innerWidth
		});

		if (decision.fallback) {
			fallback = true;
			console.info(`[RainCanvas] fallback: ${decision.reason}`);
			return;
		}

		let cancelled = false;
		// Note: WebGL probe used to happen here, but it created the GL context
		// while the canvas was still at its default 300×150 — that became the
		// permanent viewport, so rain only rendered in a top-left patch. The
		// probe now lives inside initRain(), after the drawingbuffer is sized.
		import('./rain.ts')
			.then(({ initRain }) => initRain(canvas))
			.then((instance) => {
				if (cancelled) {
					instance.destroy();
					return;
				}
				rain = instance;
				console.info('[RainCanvas] initialized');
			})
			.catch((err) => {
				console.error('[RainCanvas] init failed — falling back to gradient', err);
				fallback = true;
			});

		const onResize = () => {
			if (rain) rain.resize();
		};
		window.addEventListener('resize', onResize, { passive: true });

		return () => {
			cancelled = true;
			window.removeEventListener('resize', onResize);
			if (rain) rain.destroy();
			rain = null;
		};
	});
</script>

<div class="rain-wrap" class:fallback>
	<canvas bind:this={canvas} class="rain-canvas" aria-hidden="true"></canvas>
</div>

<style>
	.rain-wrap {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
		z-index: 0;
	}
	.rain-canvas {
		width: 100%;
		height: 100%;
		display: block;
	}
	.rain-wrap.fallback .rain-canvas {
		display: none;
	}
</style>
