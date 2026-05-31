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
	aria-labelledby="friboard-wordmark-title"
	style="--scale: {size};"
>
	<title id="friboard-wordmark-title">FRIBOARD</title>
	<defs>
		<linearGradient id="friboard-gold" x1="0%" y1="0%" x2="0%" y2="100%">
			<stop offset="0%" stop-color="#e2c089" />
			<stop offset="100%" stop-color="#b88a4a" />
		</linearGradient>
	</defs>

	{#if showMonogram}
		<text class="monogram" x="400" y="68" text-anchor="middle" fill="url(#friboard-gold)">
			A —
		</text>
		<text class="lettering" x="400" y="180" text-anchor="middle" fill="url(#friboard-gold)">
			FRIBOARD
		</text>
	{:else}
		<text class="lettering" x="400" y="100" text-anchor="middle" fill="url(#friboard-gold)">
			FRIBOARD
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
		font-weight: 200;
		font-size: 92px;
		letter-spacing: 18px;
	}

	.monogram {
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		font-weight: 300;
		font-size: 42px;
		letter-spacing: 6px;
		opacity: 0.78;
	}
</style>
