import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/vue';
import PrimeVue from 'primevue/config';
import LibraryAgentsTabSection from '@/components/library/LibraryAgentsTabSection.vue';
import type { AgentFileEntry } from '@/ipc/types';

const DELAY_MS = 220;

const entries = [
  {
    name: 'reviewer',
    path: 'C:\\repo\\.github\\agents\\reviewer.agent.md',
    scope: 'project',
    canonical: true,
    loadStatus: 'loaded',
  },
] satisfies AgentFileEntry[];

function mount(agentBusyName: string | null = null) {
  return render(LibraryAgentsTabSection, {
    props: {
      title: 'Project',
      keyPrefix: 'project',
      entries,
      currentAgentName: null,
      agentBusyName,
      activeSession: true,
    },
    global: { plugins: [PrimeVue] },
  });
}

function selectButton(container: Element): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((btn) =>
    btn.textContent?.includes('Select'),
  );

  if (!button) throw new Error('Select button not found');

  return button;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('LibraryAgentsTabSection select loading affordance (#78)', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test('does not render the loading affordance on an instant select', async () => {
    const utils = mount();

    await utils.rerender({ agentBusyName: 'reviewer' });
    expect(selectButton(utils.container).classList.contains('p-button-loading')).toBe(false);
    expect(selectButton(utils.container).disabled).toBe(true);

    await utils.rerender({ agentBusyName: null });
    await sleep(DELAY_MS);
    expect(selectButton(utils.container).classList.contains('p-button-loading')).toBe(false);
    expect(selectButton(utils.container).disabled).toBe(false);
  });

  test('renders the loading affordance once select remains pending', async () => {
    const utils = mount();

    await utils.rerender({ agentBusyName: 'reviewer' });
    await sleep(DELAY_MS);

    expect(selectButton(utils.container).classList.contains('p-button-loading')).toBe(true);
  });

  test('flags SDK-rejected agents instead of rendering a normal select action', () => {
    const utils = render(LibraryAgentsTabSection, {
      props: {
        title: 'Project',
        keyPrefix: 'project',
        entries: [
          {
            name: 'broken',
            path: 'C:\\repo\\.github\\agents\\broken.agent.md',
            scope: 'project',
            canonical: true,
            loadStatus: 'rejected',
            loadMessage: 'broken.agent.md: custom agent markdown frontmatter is malformed',
          },
        ] satisfies AgentFileEntry[],
        currentAgentName: null,
        agentBusyName: null,
        activeSession: true,
      },
      global: { plugins: [PrimeVue] },
    });

    expect(utils.getByText('SDK rejected')).toBeTruthy();
    expect(utils.getByText('Fix')).toBeTruthy();
    expect(
      utils.getByText('broken.agent.md: custom agent markdown frontmatter is malformed'),
    ).toBeTruthy();
  });
});
