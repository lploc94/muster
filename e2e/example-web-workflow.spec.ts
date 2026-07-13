import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import { TaskEngine } from '../src/task/engine';
import { TaskStore } from '../src/task/store';
import type { Backend, BackendCapabilities, NormalizedEvent } from '../src/types';
import { createEngineDomainPort } from '../src/commands/domain-adapter';
import { CommandService } from '../src/commands/service';
import { getWorkflowRunForRoot } from '../src/workflow/store';

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

function fakeBackend(): Backend {
  return {
    name: 'fake',
    capabilities: MCP_CAPS,
    async *run(): AsyncIterable<NormalizedEvent> {
      yield { type: 'sessionStarted', sessionId: 'example-web' };
      yield { type: 'turnCompleted' };
    },
    extractSessionId: (_raw, last) => last,
  };
}

async function run(service: CommandService, input: string) {
  const result = await service.handleInput(input);
  expect(result && 'ok' in result, input).toBe(true);
  if (result && 'ok' in result) expect(result.ok, input).toBe(true);
  return result;
}

function writePaletteApp(root: string) {
  fs.writeFileSync(
    path.join(root, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Muster Palette Fixture</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="shell">
      <section class="palette" aria-label="Palette">
        <h1>Palette Lab</h1>
        <p id="contrast">Selected: Ocean ink. Contrast: AAA</p>
        <div class="swatches" role="list">
          <button class="swatch" data-name="Ocean ink" data-contrast="AAA" style="--swatch:#12355b" aria-label="Ocean ink"></button>
          <button class="swatch" data-name="Sunlit coral" data-contrast="AA" style="--swatch:#ff715b" aria-label="Sunlit coral"></button>
          <button class="swatch" data-name="Mint fog" data-contrast="AAA" style="--swatch:#8bd7d2" aria-label="Mint fog"></button>
        </div>
        <button id="reset" type="button">Reset</button>
      </section>
    </main>
    <script src="./app.js"></script>
  </body>
</html>
`,
  );
  fs.writeFileSync(
    path.join(root, 'styles.css'),
    `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
  background: #f4f7f8;
  color: #172026;
}

.shell {
  width: min(680px, calc(100vw - 32px));
}

.palette {
  border: 1px solid #cfd8dc;
  border-radius: 8px;
  padding: 24px;
  background: white;
}

.swatches {
  display: flex;
  gap: 12px;
  margin: 20px 0;
}

.swatch {
  width: 64px;
  aspect-ratio: 1;
  border: 3px solid transparent;
  border-radius: 8px;
  background: var(--swatch);
  cursor: pointer;
}

.swatch[aria-pressed="true"] {
  border-color: #172026;
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'app.js'),
    `const contrast = document.querySelector('#contrast');
const reset = document.querySelector('#reset');
const swatches = [...document.querySelectorAll('.swatch')];

function select(button) {
  swatches.forEach((swatch) => swatch.setAttribute('aria-pressed', String(swatch === button)));
  contrast.textContent = \`Selected: \${button.dataset.name}. Contrast: \${button.dataset.contrast}\`;
}

swatches.forEach((button) => button.addEventListener('click', () => select(button)));
reset.addEventListener('click', () => select(swatches[0]));
select(swatches[0]);
`,
  );
}

test('native slash workflow can drive an example web implementation journey', async ({ page }) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-example-web-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'index.html'), '<!doctype html><title>Pending</title>');
    const store = TaskStore.load({ filePath: path.join(tempRoot, 'tasks.json') });
    const engine = TaskEngine.load({
      store,
      makeBackend: () => fakeBackend(),
      clock: () => '2026-07-13T04:00:00.000Z',
    });
    let focusedTaskId: string | undefined;
    const service = new CommandService({
      domain: createEngineDomainPort({
        engine,
        store,
        defaultBackend: 'claude',
        cwd: tempRoot,
        getFocusedTaskId: () => focusedTaskId,
        setFocusedTaskId: (id) => {
          focusedTaskId = id;
        },
      }),
      interaction: {
        confirm: async () => true,
        choose: async (_message, options) => options[0],
        ask: async () => undefined,
      },
    });

    await run(service, '/new Build a colour-palette page with selectable swatches, contrast label and reset action');
    await engine.whenIdle();
    await run(service, '/think Palette page requirements');
    await run(service, '/plan Palette page requirements');
    expect(getWorkflowRunForRoot(store.getFile(), focusedTaskId!)?.phase).toBe('awaiting_plan_approval');
    await run(service, '/tasks');
    await run(service, '/status');
    await run(service, '/context');
    await run(service, '/approve');
    await engine.whenIdle();
    await run(service, '/implement palette fixture');

    writePaletteApp(tempRoot);

    await run(service, '/test browser behavior');
    await engine.whenIdle();
    await run(service, '/review fixture diff');
    await engine.whenIdle();
    await run(service, '/debug injected contrast assertion failure');
    await engine.whenIdle();
    await run(service, '/verify browser behavior');
    await engine.whenIdle();
    await run(service, '/finish');
    const exported = await run(service, '/export json');
    expect(JSON.stringify(exported)).toContain('workflow');
    await run(service, '/archive');

    await page.goto(`file://${path.join(tempRoot, 'index.html')}`);
    await expect(page.getByRole('heading', { name: 'Palette Lab' })).toBeVisible();
    await expect(page.getByText('Selected: Ocean ink. Contrast: AAA')).toBeVisible();
    await page.getByRole('button', { name: 'Sunlit coral' }).click();
    await expect(page.getByText('Selected: Sunlit coral. Contrast: AA')).toBeVisible();
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByText('Selected: Ocean ink. Contrast: AAA')).toBeVisible();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
