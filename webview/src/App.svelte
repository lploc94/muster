<script lang="ts">
  import { onMount } from 'svelte';
  import Toolbar from './components/Toolbar.svelte';
  import ChatThread from './components/ChatThread.svelte';
  import Composer from './components/Composer.svelte';
  import { thread } from './lib/turn-state.svelte';
  import { isExtMessage } from './lib/protocol';

  onMount(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (!isExtMessage(msg)) return;

      switch (msg.type) {
        case 'turnStart':
          thread.backend = msg.backend ?? thread.backend;
          thread.startTurn(msg.runId, msg.prompt);
          break;

        case 'event':
          if (msg.runId !== thread.runId) return; // ignore late/cancelled-turn events (§4.4)
          thread.applyEvent(msg.event);
          break;

        case 'turnDone':
          if (msg.runId !== thread.runId) return;
          thread.endTurn();
          break;

        case 'turnError':
          if (msg.runId !== thread.runId) return;
          thread.pushError(msg.message);
          thread.endTurn();
          break;

        case 'sessionReset':
          thread.reset();
          break;

        case 'askPending':
          // Phase 3 (AskCard) — not handled in the MVP scaffold.
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

<Toolbar />
<ChatThread />
<Composer />
