<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import {
		DEFAULT_BAN_REASON_PRESETS,
		MAX_BAN_REASON_PRESETS,
		MAX_BAN_REASON_LENGTH,
		banReasonPresetsProblem,
		normalizeBanReasonPresets
	} from '$lib/ban-reasons';

	let { org, reasons }: { org: { id: string }; reasons: string[] } = $props();
	let open = $state(false);
	let busy = $state(false);
	let draft = $state(untrack(() => [...reasons]));
	let problem = $derived(banReasonPresetsProblem(draft));
	let changed = $derived(
		JSON.stringify(normalizeBanReasonPresets(draft)) !== JSON.stringify(reasons)
	);

	function edit() {
		if (!open) draft = [...reasons];
		open = !open;
	}

	async function save() {
		if (busy || problem) return;
		busy = true;
		try {
			await api('PATCH', `/api/orgs/${encodeURIComponent(org.id)}`, {
				banReasonPresets: normalizeBanReasonPresets(draft)
			});
			toast('Ban reason presets saved for every server in this organisation.', 'ok');
			await invalidateAll();
			open = false;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="mb-4 panel px-4 py-3.5 sm:px-5">
	<button
		type="button"
		class="flex min-h-6 w-full cursor-pointer items-center gap-3 text-left"
		aria-expanded={open}
		disabled={busy}
		onclick={edit}
	>
		<span class="caps whitespace-nowrap text-mist-400">Preset reasons</span>
		<span class="min-w-0 flex-1 truncate text-[12px] text-mist-600">
			{open
				? ''
				: reasons.length
					? `${reasons.length} · ${reasons.join(', ')}`
					: 'None — enter reasons manually'}
		</span>
		<span class="inline-flex items-center gap-1.5 caps text-mist-400">
			{open ? 'Close' : 'Edit'}
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				aria-hidden="true"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg
			>
		</span>
	</button>
	{#if open}
		<form
			class="mt-4"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<p class="mb-3 text-[13px] text-mist-400">
				Suggestions in every ban dialog across this organisation, including bans on one server.
				Admins can still type or edit a reason. Existing bans keep their reasons.
			</p>
			<div class="space-y-2">
				{#each draft as _, index (index)}
					<div class="flex items-center gap-2">
						<label class="min-w-0 flex-1">
							<span class="sr-only">Reason {index + 1}</span>
							<input
								class="input"
								type="text"
								maxlength={MAX_BAN_REASON_LENGTH}
								placeholder="Enter a ban reason…"
								disabled={busy}
								bind:value={draft[index]}
							/>
						</label>
						<button
							class="btn btn-sm btn-ghost"
							type="button"
							disabled={busy}
							aria-label="Remove reason {index + 1}"
							onclick={() => {
								draft = draft.filter((_, i) => i !== index);
							}}>Remove</button
						>
					</div>
				{:else}
					<p class="text-[13px] text-mist-600">No presets. Admins enter reasons manually.</p>
				{/each}
			</div>
			<div class="mt-3 flex flex-wrap items-center gap-3">
				<button
					class="btn btn-sm"
					type="button"
					disabled={busy || draft.length >= MAX_BAN_REASON_PRESETS}
					onclick={() => {
						draft = [...draft, ''];
					}}>Add reason</button
				>
				<span class="text-[12px] text-mist-600"
					>{draft.length}/{MAX_BAN_REASON_PRESETS} reasons · up to {MAX_BAN_REASON_LENGTH} characters
					each</span
				>
			</div>
			{#if problem}<p class="note text-danger" role="status">{problem}</p>{/if}
			<div class="mt-4 flex flex-wrap justify-end gap-2">
				<button
					class="btn btn-ghost"
					type="button"
					disabled={busy}
					onclick={() => {
						draft = [...DEFAULT_BAN_REASON_PRESETS];
					}}>Restore defaults</button
				>
				<button class="btn btn-primary" type="submit" disabled={busy || !!problem || !changed}
					>Save</button
				>
			</div>
		</form>
	{/if}
</div>
