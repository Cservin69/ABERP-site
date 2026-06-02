<script lang="ts">
	interface Props {
		size?: number;
		showMonogram?: boolean;
	}

	let { size = 1, showMonogram = true }: Props = $props();

	const viewBoxWidth = 800;
	let viewBoxHeight = $derived(showMonogram ? 220 : 140);
</script>

<svg
	class="wordmark"
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 {viewBoxWidth} {viewBoxHeight}"
	role="img"
	aria-labelledby="abenerp-wordmark-title"
	style="--scale: {size};"
>
	<title id="abenerp-wordmark-title">ABENERP</title>
	<defs>
		<linearGradient id="abenerp-gold" x1="0%" y1="0%" x2="0%" y2="100%">
			<stop offset="0%" stop-color="#f2cb6e" />
			<stop offset="100%" stop-color="#c2862b" />
		</linearGradient>
	</defs>

	{#if showMonogram}
		<text class="monogram" x="400" y="68" text-anchor="middle" fill="url(#abenerp-gold)">
			A —
		</text>
		<text class="lettering" x="400" y="180" text-anchor="middle" fill="url(#abenerp-gold)">
			ABENERP
		</text>
	{:else}
		<text class="lettering" x="400" y="100" text-anchor="middle" fill="url(#abenerp-gold)">
			ABENERP
		</text>
	{/if}
</svg>

<style>
	.wordmark {
		display: block;
		width: 100%;
		height: auto;
		max-width: 720px;
		margin: 0 auto;
	}

	.lettering {
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		/* Thickened ~3x vs the original ExtraLight (200): black weight + an
		   outward stroke in the same gold gradient widens each stem so the
		   mark reads heavy against the rain canvas. paint-order keeps the
		   stroke under the fill so the gold stays crisp. */
		font-weight: 900;
		font-size: 92px;
		letter-spacing: 18px;
		stroke: url(#abenerp-gold);
		stroke-width: 6px;
		stroke-linejoin: round;
		paint-order: stroke fill;
	}

	.monogram {
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		/* Bumped to match the heavier lettering so the accent stays balanced. */
		font-weight: 800;
		font-size: 42px;
		letter-spacing: 6px;
		stroke: url(#abenerp-gold);
		stroke-width: 2.5px;
		stroke-linejoin: round;
		paint-order: stroke fill;
		opacity: 0.78;
	}
</style>
