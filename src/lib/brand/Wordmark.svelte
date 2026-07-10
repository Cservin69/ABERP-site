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
		<!--
		  Áben mark — compact geometric A, ported verbatim from
		  Cservin69/ABERP-Editions main b5c8f5f (static/favicon.svg). Embedded as
		  a nested <svg> so its "10 8 204 204" coordinate system stays intact and
		  the mark drops, centred, into the ~42px slot the old hand-drawn "A —"
		  text monogram held — same footprint, no transform math. The swoosh
		  variant lives in static/brand-mark.svg; the header uses the compact A
		  so it centres cleanly above the ABENERP wordmark. Gold stops are the
		  editions --color-brand-gold-* hexes.
		-->
		<svg
			class="mark"
			x="372"
			y="14"
			width="56"
			height="56"
			viewBox="10 8 204 204"
			role="img"
			aria-label="ABENERP mark"
		>
			<defs>
				<linearGradient id="abenGold" x1="0" y1="0" x2="0.35" y2="1">
					<stop offset="0" stop-color="#F6E7B4" />
					<stop offset="0.45" stop-color="#D9B451" />
					<stop offset="1" stop-color="#9C7A2A" />
				</linearGradient>
			</defs>
			<path fill="url(#abenGold)" d="M105,24 L112,66 L66,196 L28,196 Z" />
			<path fill="url(#abenGold)" d="M119,24 L196,196 L158,196 L112,66 Z" />
			<path fill="url(#abenGold)" d="M82,150 L112,134 L142,150 L142,166 L112,150 L82,166 Z" />
		</svg>
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
</style>
