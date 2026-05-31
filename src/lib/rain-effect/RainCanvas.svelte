<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import type { RainInstance } from './rain.ts';

	let canvas: HTMLCanvasElement;
	let rain: RainInstance | null = null;
	let fallback = $state(false);

	onMount(() => {
		if (!browser) return;

		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const saveData =
			(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
			true;
		const tinyViewport = window.innerWidth < 480;

		if (reducedMotion || saveData || tinyViewport) {
			fallback = true;
			return;
		}

		const probe = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
		if (!probe) {
			fallback = true;
			return;
		}

		let cancelled = false;
		import('./rain.ts')
			.then(({ initRain }) => initRain(canvas))
			.then((instance) => {
				if (cancelled) {
					instance.destroy();
					return;
				}
				rain = instance;
			})
			.catch((err) => {
				console.error('[RainCanvas] init failed', err);
				fallback = true;
			});

		return () => {
			cancelled = true;
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
