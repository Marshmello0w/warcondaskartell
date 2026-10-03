<script lang="ts">
	// The org's roles in order, first to last: the columns of the roles page and every role picker.
	// A row moves with its arrow buttons (keyboard, screen readers) or by dragging its handle
	// (mouse, touch and pen alike, through pointer events). Nothing is saved until Save order,
	// which sends the whole list.
	import { tick, untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { RoleView } from '$lib/types';

	let {
		roles,
		busy = false,
		onsave,
		onclose
	}: {
		roles: RoleView[];
		busy?: boolean;
		onsave: (ids: string[]) => void;
		onclose: () => void;
	} = $props();

	/** the order being edited, as role ids; taken from the page once, when the dialog opens */
	let order = $state(untrack(() => roles.map((r) => r.id)));
	let byId = $derived(new Map(roles.map((r) => [r.id, r])));
	let rows = $derived(order.flatMap((id) => byId.get(id) ?? []));
	let changed = $derived(order.join() !== roles.map((r) => r.id).join());

	/** the row last moved, marked so the eye can follow it */
	let moved = $state<string | null>(null);
	/** what a screen reader hears after a move */
	let said = $state('');
	/** the row being dragged, and the pointer dragging it */
	let drag = $state<{ id: string; pointer: number } | null>(null);
	let list: HTMLOListElement | undefined = $state();

	function place(id: string, to: number) {
		const next = order.filter((v) => v !== id);
		next.splice(to, 0, id);
		order = next;
	}
	function settle(id: string) {
		moved = id;
		const at = rows.findIndex((r) => r.id === id);
		if (at >= 0) said = `${rows[at].name}: ${at + 1} of ${rows.length}.`;
	}

	async function step(id: string, by: -1 | 1) {
		const to = order.indexOf(id) + by;
		if (to < 0 || to >= order.length) return;
		place(id, to);
		settle(id);
		// a row moved in the page can lose focus, and at either end the button just pressed turns
		// disabled: put focus back on the row, on the same arrow while it still works
		await tick();
		const row = list?.querySelector(`li[data-id="${CSS.escape(id)}"]`);
		const same = row?.querySelector<HTMLButtonElement>(`button[data-step="${by}"]:enabled`);
		(same ?? row?.querySelector<HTMLButtonElement>('button:enabled'))?.focus();
	}

	function grab(e: PointerEvent, id: string) {
		if (busy || !list || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
		if (drag && list.hasPointerCapture(drag.pointer)) return;
		e.preventDefault();
		// captured by the list, which stays put while its rows move (a moved row can lose it)
		try {
			list.setPointerCapture(e.pointerId);
		} catch {
			return; // the pointer is already gone
		}
		drag = { id, pointer: e.pointerId };
		moved = null;
	}
	function follow(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointer || !list) return;
		// the row's slot is the number of other rows whose middle is above the pointer, measured on
		// layout positions (offsetTop) so a row still sliding into place is not counted twice
		const y = e.clientY - list.getBoundingClientRect().top;
		let to = 0;
		for (const row of list.children as HTMLCollectionOf<HTMLElement>)
			if (row.dataset.id !== drag.id && row.offsetTop + row.offsetHeight / 2 < y) to++;
		if (to !== order.indexOf(drag.id)) place(drag.id, to);
	}
	function release(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointer) return;
		const { id } = drag;
		drag = null;
		settle(id);
	}
</script>

<Modal title="Role order" {onclose}>
	<p class="mb-3 text-[12.5px] text-mist-400">
		First is leftmost on the roles page and first in every role picker.
	</p>
	<ol
		bind:this={list}
		class="relative border-t border-white/6"
		onpointermove={follow}
		onpointerup={release}
		onpointercancel={release}
		onlostpointercapture={release}
	>
		{#each rows as r, i (r.id)}
			<li
				data-id={r.id}
				animate:flip={{ duration: 150 }}
				class="flex items-center gap-2.5 border-b border-white/6 py-2 pr-2 pl-1 {drag?.id === r.id
					? 'relative z-10 bg-ink-800 shadow-pop ring-1 ring-accent/50 ring-inset'
					: moved === r.id
						? 'bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]'
						: ''}"
			>
				<span
					class="flex shrink-0 cursor-grab touch-none items-center self-stretch px-1 pointer-coarse:px-2.5 {drag?.id ===
					r.id
						? 'cursor-grabbing text-accent'
						: 'text-mist-600 hover:text-mist-400'}"
					aria-hidden="true"
					onpointerdown={(e) => grab(e, r.id)}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
						><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle
							cx="9"
							cy="12"
							r="1.6"
						/><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle
							cx="15"
							cy="18"
							r="1.6"
						/></svg
					>
				</span>
				<span class="w-4 shrink-0 text-right text-[12px] text-mist-600 tabular">{i + 1}</span>
				<span class="flex min-w-0 grow flex-wrap items-center gap-x-2 gap-y-0.5">
					<span class="truncate">{r.name}</span>
					{#if r.builtin}<Badge
							tone={r.builtin === 'admin' ? 'accent' : r.builtin === 'operator' ? 'info' : ''}
							>built-in</Badge
						>{/if}
				</span>
				<span class="inline-flex shrink-0 gap-1">
					<button
						type="button"
						class="btn w-9 px-0 pointer-coarse:size-11"
						aria-label="Move {r.name} up"
						data-step="-1"
						disabled={busy || i === 0}
						onclick={() => step(r.id, -1)}
						><svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg
						></button
					>
					<button
						type="button"
						class="btn w-9 px-0 pointer-coarse:size-11"
						aria-label="Move {r.name} down"
						data-step="1"
						disabled={busy || i === rows.length - 1}
						onclick={() => step(r.id, 1)}
						><svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7" /></svg
						></button
					>
				</span>
			</li>
		{/each}
	</ol>
	<p class="sr-only" aria-live="polite">{said}</p>
	{#snippet actions()}
		<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
		<button
			type="button"
			class="btn btn-primary"
			disabled={busy || !changed}
			onclick={() => onsave([...order])}>Save order</button
		>
	{/snippet}
</Modal>
