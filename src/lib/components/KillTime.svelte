<script lang="ts">
	let { kill, text }: { kill: { timeQuality?: string }; text: string } = $props();
	let known = $derived(kill.timeQuality === 'clock');
</script>

<span
	title={known
		? 'Kill time estimated from the round clock and original packet receipt.'
		: 'Packet receipt time. The kill time cannot be reliably reconstructed.'}
>
	{known ? '≈ ' : ''}{text}{#if !known}<span class="text-mist-600"> · received</span>{/if}
</span>
