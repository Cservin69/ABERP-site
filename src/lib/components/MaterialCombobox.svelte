<script lang="ts">
	// Accessible typeahead combobox for the quote form's Material field (S412).
	// Replaces a native <select>: free-text filter + filtered listbox, full
	// keyboard traversal, and a WCAG 1.2 combobox role set. The committed value is
	// always one of `options` (typing only filters) and is mirrored into a hidden
	// input so the form POSTs `material` exactly as the old <select> did.
	import {
		filterMaterialOptions,
		labelForValue,
		MIN_FILTER_CHARS,
		type MaterialOption
	} from '$lib/material-options';

	type Props = {
		id: string;
		name: string;
		options: MaterialOption[];
		value: string;
	};

	let { id, name, options, value = $bindable() }: Props = $props();

	// The text in the visible input. While the user types it becomes the filter
	// query (value is NOT touched until they pick an option). Seeded from the
	// committed value's label by the sync $effect below.
	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(-1);

	const listboxId = $derived(`${id}-listbox`);
	const optionId = (i: number) => `${id}-opt-${i}`;

	const filtered = $derived(filterMaterialOptions(options, query));

	// Keep the textbox in sync if the committed value changes from outside (e.g.
	// catalogue loads and rebuilds the option labels) while the user isn't typing.
	$effect(() => {
		if (!open) query = labelForValue(options, value);
	});

	function openList() {
		open = true;
		// Highlight the committed option if it's in the current filter, else the
		// first row, so ArrowDown/Enter has a sensible starting point.
		const committed = filtered.findIndex((o) => o.value === value);
		activeIndex = committed >= 0 ? committed : filtered.length > 0 ? 0 : -1;
	}

	function commit(opt: MaterialOption) {
		value = opt.value;
		query = labelForValue(options, opt.value);
		open = false;
		activeIndex = -1;
	}

	function clear() {
		// Esc clears the textbox and closes; `unknown` is the canonical
		// no-preference default the backend already accepts.
		value = 'unknown';
		query = '';
		open = false;
		activeIndex = -1;
	}

	function onInput(event: Event) {
		query = (event.target as HTMLInputElement).value;
		open = true;
		activeIndex = filtered.length > 0 ? 0 : -1;
	}

	function move(delta: number) {
		if (!open) {
			openList();
			return;
		}
		if (filtered.length === 0) return;
		const next = activeIndex + delta;
		activeIndex = ((next % filtered.length) + filtered.length) % filtered.length;
	}

	function onKeydown(event: KeyboardEvent) {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				move(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				move(-1);
				break;
			case 'Enter':
				if (open && activeIndex >= 0 && activeIndex < filtered.length) {
					// Don't submit the form — selecting is the intent here.
					event.preventDefault();
					commit(filtered[activeIndex]);
				}
				break;
			case 'Escape':
				event.preventDefault();
				clear();
				break;
			case 'Home':
				if (open && filtered.length > 0) {
					event.preventDefault();
					activeIndex = 0;
				}
				break;
			case 'End':
				if (open && filtered.length > 0) {
					event.preventDefault();
					activeIndex = filtered.length - 1;
				}
				break;
		}
	}

	function onBlur() {
		// Discard any unmatched in-progress text and restore the committed label.
		open = false;
		activeIndex = -1;
		query = labelForValue(options, value);
	}
</script>

<div class="combobox">
	<!-- Mirrors the committed value into the multipart POST exactly like the old
	     <select name="material">. The visible input is intentionally unnamed so
	     free-text never reaches the server. -->
	<input type="hidden" {name} {value} />
	<input
		{id}
		class="combobox-input"
		type="text"
		role="combobox"
		aria-expanded={open}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
		autocomplete="off"
		autocapitalize="none"
		autocorrect="off"
		spellcheck="false"
		placeholder="Not sure / ask us"
		value={query}
		oninput={onInput}
		onkeydown={onKeydown}
		onfocus={openList}
		onblur={onBlur}
	/>
	{#if open}
		<ul
			class="listbox"
			id={listboxId}
			role="listbox"
			aria-label="Material"
			onpointerdown={(e) => e.preventDefault()}
		>
			{#if filtered.length === 0}
				<li class="empty">No match — keep typing or choose &ldquo;Other&rdquo;.</li>
			{:else}
				{#each filtered as opt, i (opt.value)}
					<!-- Keyboard selection is handled on the combobox input (Enter on the
					     active option), per the WCAG combobox pattern — options need no
					     per-row key handler. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id={optionId(i)}
						role="option"
						aria-selected={opt.value === value}
						class:active={i === activeIndex}
						onclick={() => commit(opt)}
						onpointermove={() => (activeIndex = i)}
					>
						{opt.label}
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>

<p class="hint">
	Type to filter — the list narrows after {MIN_FILTER_CHARS} characters. Use ↑ ↓ then Enter, or tap a
	row.
</p>

<style>
	.combobox {
		position: relative;
	}

	.combobox-input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.65rem 0.75rem;
		font-family: inherit;
		font-size: 0.95rem;
		color: #f3eee5;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(212, 165, 116, 0.35);
		border-radius: 2px;
		transition:
			border-color 160ms ease,
			background-color 160ms ease;
	}

	.combobox-input:focus-visible {
		border-color: #d4a574;
		outline: none;
		background: rgba(255, 255, 255, 0.06);
	}

	.combobox-input::placeholder {
		color: rgba(243, 238, 229, 0.45);
	}

	.listbox {
		position: absolute;
		z-index: 20;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		max-height: 14rem;
		overflow-y: auto;
		background: #161b2c;
		border: 1px solid rgba(212, 165, 116, 0.45);
		border-radius: 2px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
	}

	.listbox li[role='option'] {
		padding: 0.55rem 0.6rem;
		font-size: 0.9rem;
		color: #f3eee5;
		border-radius: 2px;
		cursor: pointer;
		/* Comfortable touch target on mobile. */
		min-height: 1.1rem;
	}

	.listbox li[role='option'].active,
	.listbox li[role='option'][aria-selected='true'] {
		background: rgba(212, 165, 116, 0.18);
	}

	.listbox li[role='option'].active {
		background: rgba(212, 165, 116, 0.28);
	}

	.listbox li.empty {
		padding: 0.55rem 0.6rem;
		font-size: 0.85rem;
		font-weight: 300;
		color: rgba(243, 238, 229, 0.6);
	}

	.hint {
		margin: 0.35rem 0 0;
		font-size: 0.75rem;
		font-weight: 300;
		color: rgba(243, 238, 229, 0.55);
	}
</style>
