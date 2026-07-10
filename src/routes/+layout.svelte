<script lang="ts">
	// Global design tokens (radius scale). Imported at the root layout so the
	// `:root` custom properties cascade to every route's scoped styles.
	import '$lib/tokens.css';

	let { data, children } = $props();

	const canonical = $derived(`${data.publicSiteUrl}/`);
	const ogImage = $derived(`${data.publicSiteUrl}/og-image.png`);
</script>

<!--
  Canonical + Open-Graph meta. Sourced from the root server load
  (`+layout.server.ts`), which reads ABERP_SITE_PUBLIC_URL via the shared
  `publicSiteUrl()` helper. Per-page <svelte:head> blocks override <title> +
  per-page descriptions; this layout owns only host-level tags that should be
  identical site-wide.
-->
<svelte:head>
	<link rel="canonical" href={canonical} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={ogImage} />
	<meta name="twitter:image" content={ogImage} />
</svelte:head>

{@render children()}
