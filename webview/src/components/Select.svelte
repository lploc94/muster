<script module lang="ts">
  let uidCounter = 0;
  /** Stable per-instance id suffix for ARIA wiring (no Math.random needed). */
  function nextUid(): number {
    return ++uidCounter;
  }

  /**
   * Sentence-case an option for display: capitalise the first letter and leave
   * the rest untouched, so raw lowercase ids ("claude", "coordinator") read
   * cleanly while already-formatted names ("GPT-5.5", "Claude Fable 5") keep
   * their casing.
   */
  function toSentenceCase(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return text;
    return trimmed.replace(/\p{L}/u, (char) => char.toUpperCase());
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';

  interface SelectOption {
    value: string;
    label: string;
  }

  let {
    value = $bindable(''),
    options,
    id = undefined,
    disabled = false,
    ariaLabel = undefined,
    placeholder = 'Select…',
    onchange = undefined,
  }: {
    value?: string;
    options: SelectOption[];
    id?: string;
    disabled?: boolean;
    ariaLabel?: string;
    placeholder?: string;
    onchange?: (value: string) => void;
  } = $props();

  const instanceId = `muster-select-${nextUid()}`;
  const baseId = $derived(id ?? instanceId);

  let open = $state(false);
  let activeIndex = $state(-1);
  let menuStyle = $state('');
  let triggerEl = $state<HTMLDivElement>();
  let menuEl = $state<HTMLUListElement>();

  /** Display text for an option: sentence-cased label, or the id when unlabelled. */
  function optionText(opt: SelectOption): string {
    const raw = opt.label.trim().length > 0 ? opt.label : opt.value;
    return toSentenceCase(raw);
  }

  const selectedIndex = $derived(options.findIndex((o) => o.value === value));
  const displayLabel = $derived(
    selectedIndex >= 0 ? optionText(options[selectedIndex]) : placeholder,
  );
  const activeOptionId = $derived(activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined);

  /**
   * Position the menu against the trigger with fixed coordinates. Combined with
   * the body portal this escapes any scrollable/overflow ancestor (the Settings
   * panel scrolls), so the menu is never clipped — matching a native <select>.
   */
  function positionMenu() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const gap = 4;
    const maxHeight = 260;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < Math.min(maxHeight, 160) && spaceAbove > spaceBelow;
    const height = Math.max(80, Math.min(maxHeight, openUp ? spaceAbove : spaceBelow));
    const vertical = openUp
      ? `bottom: ${window.innerHeight - rect.top + gap}px;`
      : `top: ${rect.bottom + gap}px;`;
    menuStyle = `position: fixed; left: ${rect.left}px; width: ${rect.width}px; ${vertical} max-height: ${height}px;`;
  }

  function scrollActiveIntoView() {
    if (activeIndex < 0) return;
    menuEl?.querySelector<HTMLElement>(`#${CSS.escape(`${baseId}-opt-${activeIndex}`)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  async function openMenu() {
    if (disabled || open) return;
    open = true;
    activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
    positionMenu();
    await tick();
    positionMenu();
    scrollActiveIntoView();
  }

  function closeMenu() {
    open = false;
    activeIndex = -1;
  }

  function commit(index: number) {
    const opt = options[index];
    if (opt && opt.value !== value) {
      value = opt.value;
      onchange?.(opt.value);
    }
    closeMenu();
    triggerEl?.focus();
  }

  function setActive(index: number) {
    if (!options.length) return;
    activeIndex = ((index % options.length) + options.length) % options.length;
    scrollActiveIntoView();
  }

  function onKeydown(event: KeyboardEvent) {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) openMenu();
        else setActive(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) openMenu();
        else setActive(activeIndex - 1);
        break;
      case 'Home':
        if (open) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (open) {
          event.preventDefault();
          setActive(options.length - 1);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) commit(activeIndex);
        else openMenu();
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        }
        break;
      case 'Tab':
        if (open) closeMenu();
        break;
    }
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (!open) return;
    const target = event.target as Node | null;
    if (target && (triggerEl?.contains(target) || menuEl?.contains(target))) return;
    closeMenu();
  }

  function onWindowScroll(event: Event) {
    if (!open) return;
    // Reposition while the page scrolls; ignore scrolls inside the menu itself.
    if (event.target instanceof Node && menuEl?.contains(event.target)) return;
    positionMenu();
  }

  // `scroll` does not bubble, so a `<svelte:window onscroll>` (bubble phase) misses
  // scrolls inside inner overflow containers such as the settings panel body — the
  // fixed, portaled menu would then stay put and detach from its trigger. A
  // capture-phase window listener sees every scroll, wherever it originates. Register
  // it only while the menu is open; the effect cleanup removes it on close/destroy.
  $effect(() => {
    if (!open) return;
    window.addEventListener('scroll', onWindowScroll, true);
    return () => window.removeEventListener('scroll', onWindowScroll, true);
  });

  /** Move the menu to <body> so `position: fixed` is viewport-relative and unclipped. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<svelte:window
  onpointerdown={onWindowPointerdown}
  onresize={() => open && positionMenu()}
/>

<div
  bind:this={triggerEl}
  {id}
  class="muster-select__trigger"
  class:muster-select__trigger--disabled={disabled}
  role="combobox"
  tabindex={disabled ? -1 : 0}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-controls={`${baseId}-listbox`}
  aria-activedescendant={activeOptionId}
  aria-label={ariaLabel}
  aria-disabled={disabled}
  onclick={() => (open ? closeMenu() : openMenu())}
  onkeydown={onKeydown}
>
  <span class="muster-select__value" class:muster-select__value--placeholder={selectedIndex < 0}>
    {displayLabel}
  </span>
  <span class="codicon codicon-chevron-down muster-select__chevron" aria-hidden="true"></span>
</div>

{#if open}
  <ul
    bind:this={menuEl}
    use:portal
    id={`${baseId}-listbox`}
    class="muster-select__menu"
    role="listbox"
    aria-label={ariaLabel}
    style={menuStyle}
  >
    {#each options as opt, index (opt.value)}
      <li
        id={`${baseId}-opt-${index}`}
        class="muster-select__option"
        class:muster-select__option--active={index === activeIndex}
        class:muster-select__option--selected={opt.value === value}
        role="option"
        aria-selected={opt.value === value}
        onmouseenter={() => (activeIndex = index)}
        onclick={() => commit(index)}
      >
        {optionText(opt)}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .muster-select__trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-height: 26px;
    box-sizing: border-box;
    padding: 4px 8px;
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-settings-dropdownBorder, transparent));
    border-radius: 4px;
    background: var(--vscode-dropdown-background, var(--vscode-settings-dropdownBackground));
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    font: inherit;
    font-size: 13px;
    line-height: 18px;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }

  .muster-select__trigger:hover {
    background: var(--vscode-dropdown-background, var(--vscode-settings-dropdownBackground));
    border-color: var(--vscode-focusBorder);
  }

  .muster-select__trigger:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .muster-select__trigger--disabled {
    opacity: 0.5;
    cursor: default;
  }

  .muster-select__value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muster-select__value--placeholder {
    color: var(--vscode-descriptionForeground);
  }

  .muster-select__chevron {
    flex: none;
    font-size: 14px;
    opacity: 0.8;
  }

  .muster-select__menu {
    z-index: 1000;
    margin: 0;
    padding: 2px;
    list-style: none;
    border: 1px solid var(--vscode-settings-dropdownListBorder, var(--vscode-dropdown-border, var(--vscode-panel-border)));
    border-radius: 4px;
    background: var(--vscode-settings-dropdownBackground, var(--vscode-dropdown-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .muster-select__option {
    padding: 4px 8px;
    border-radius: 3px;
    font-size: 13px;
    line-height: 18px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muster-select__option--active {
    background: var(--vscode-list-hoverBackground);
  }

  .muster-select__option--selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
</style>
