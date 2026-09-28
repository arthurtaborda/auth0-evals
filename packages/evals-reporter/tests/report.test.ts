/**
 * Happy path tests for src/report.ts
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { loadScores, renderHtml, groupByVariant, computeDeltas, resultVariant } from '../src/report.js';
import { makeTmpDir } from './tmp.js';

const tmpDir = makeTmpDir('report_test_');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult(
  evalId = 'react_quickstart',
  model = 'gpt-5.2',
  mode = 'baseline',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eval_id: evalId,
    model,
    mode,
    status: 'success',
    grader_pass_rate: 1.0,
    cost_usd: 0.01,
    ...overrides,
  };
}

class MockClassList {
  private readonly values: Set<string>;

  constructor(classNames = '') {
    this.values = new Set(classNames.split(/\s+/).filter(Boolean));
  }

  contains(className: string): boolean {
    return this.values.has(className);
  }

  toggle(className: string, force?: boolean): boolean {
    const active = force ?? !this.values.has(className);
    if (active) this.values.add(className);
    else this.values.delete(className);
    return active;
  }
}

class MockElement {
  value = '';
  hidden = false;
  textContent = '';
  focused = false;
  readonly dataset: Record<string, string> = {};
  readonly classList: MockClassList;
  parentSection?: MockElement;
  sectionCards: MockElement[] = [];
  themeLabel?: MockElement;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(classNames = '') {
    this.classList = new MockClassList(classNames);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  closest(selector: string): MockElement | null {
    return selector === '.detail-section' ? (this.parentSection ?? null) : null;
  }

  querySelector(selector: string): MockElement | null {
    if (selector === '.detail-card-wrap:not([hidden])') {
      return this.sectionCards.find((card) => !card.hidden) ?? null;
    }
    if (selector === '.theme-toggle-label') return this.themeLabel ?? null;
    return null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  focus(): void {
    this.focused = true;
  }
}

class MockStorage {
  private readonly values = new Map<string, string>();

  constructor(theme?: string) {
    if (theme) this.values.set('auth0-evals-theme', theme);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MockDocument {
  readonly documentElement = new MockElement();

  constructor(
    private readonly elements: Map<string, MockElement>,
    readonly cards: MockElement[],
    readonly sections: MockElement[],
    readonly panels: MockElement[],
  ) {}

  getElementById(id: string): MockElement {
    const element = this.elements.get(id);
    if (!element) throw new Error(`Missing mock element: ${id}`);
    return element;
  }

  querySelectorAll(selector: string): MockElement[] {
    if (selector === '.detail-card-wrap') return this.cards;
    if (selector === '.detail-section') return this.sections;
    if (selector === '.summary-panel') return this.panels;
    throw new Error(`Unsupported mock selector: ${selector}`);
  }
}

function runReportClient(results: Record<string, unknown>[], storedTheme?: string) {
  const html = renderHtml(results, '2024-01-01 00:00');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const finalScript = scripts.at(-1);
  if (!scripts[0] || !finalScript) throw new Error('Expected embedded report scripts');

  const panels = [...html.matchAll(/<div class="summary-panel([^"]*)" data-variant="([^"]+)"([^>]*)>/g)].map(
    (match) => {
      const panel = new MockElement(`summary-panel${match[1]}`);
      panel.dataset.variant = match[2] ?? '';
      panel.hidden = (match[3] ?? '').includes('hidden');
      return panel;
    },
  );
  const sections = [...new Set(results.map((result) => String(result.eval_id)))].sort().map((evalId) => {
    const section = new MockElement('detail-section');
    section.dataset.eval = evalId;
    return section;
  });
  const sectionsByEval = new Map(sections.map((section) => [section.dataset.eval, section]));
  const cards = results.map((result) => {
    const card = new MockElement('detail-card-wrap');
    card.dataset.model = String(result.model);
    card.dataset.variant = resultVariant(result);
    card.textContent = `${String(result.eval_id)} ${String(result.model)} ${JSON.stringify(result)}`;
    card.parentSection = sectionsByEval.get(String(result.eval_id));
    card.parentSection?.sectionCards.push(card);
    return card;
  });

  const themeToggle = new MockElement('theme-toggle');
  themeToggle.setAttribute('aria-label', 'Use dark theme');
  themeToggle.setAttribute('aria-pressed', 'false');
  themeToggle.themeLabel = new MockElement('theme-toggle-label');
  themeToggle.themeLabel.textContent = 'Dark';

  const elements = new Map<string, MockElement>();
  const addElement = (id: string, element = new MockElement()): MockElement => {
    elements.set(id, element);
    return element;
  };
  addElement('filter-variant').value = panels[0]?.dataset.variant ?? '';
  addElement('filter-eval').value = '__all__';
  addElement('filter-model').value = '__all__';
  addElement('filter-search');
  addElement('result-count').textContent = '0 runs';
  const emptyResults = addElement('empty-results');
  emptyResults.hidden = true;
  addElement('theme-toggle', themeToggle);
  addElement('clear-filters', new MockElement('clear-filters'));

  const document = new MockDocument(elements, cards, sections, panels);
  const localStorage = new MockStorage(storedTheme);
  const context = { document, localStorage };
  runInNewContext(scripts[0], context);
  runInNewContext(finalScript, context);

  return {
    document,
    localStorage,
    element: (id: string) => document.getElementById(id),
  };
}

// ── renderHtml tests ──────────────────────────────────────────────────────────

describe('renderHtml', () => {
  it('returns non-empty string', () => {
    const html = renderHtml([makeResult()], '2024-01-01 00:00');
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('contains eval_id, model name, and generated_at', () => {
    const html = renderHtml([makeResult('react_quickstart', 'gpt-5.2')], '2024-01-01 12:34');
    expect(html).toContain('react_quickstart');
    expect(html).toContain('gpt-5.2');
    expect(html).toContain('2024-01-01 12:34');
  });

  it('renders numeric format strings (no raw %.Nf placeholders)', () => {
    const html = renderHtml(
      [
        makeResult('react_quickstart', 'gpt-5.2', 'baseline', {
          cost_usd: 0.0123,
          wall_time: 4.5,
        }),
      ],
      '2024-01-01 00:00',
    );
    expect(html).not.toContain('%.4f');
    expect(html).not.toContain('%.1f');
    expect(html).not.toContain('%.2f');
    expect(html).toContain('0.0123');
    expect(html).toContain('4.5');
  });

  it('includes all evals and models', () => {
    const results = [makeResult('react_quickstart', 'gpt-5.2'), makeResult('swift_quickstart', 'claude-sonnet-4-6')];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('react_quickstart');
    expect(html).toContain('swift_quickstart');
    expect(html).toContain('gpt-5.2');
    expect(html).toContain('claude-sonnet-4-6');
  });
});

// ── loadScores + renderHtml integration ──────────────────────────────────────

describe('renderHtml from score files', () => {
  it('produces expected output from disk', () => {
    const tmpPath = tmpDir();
    const scoresFile = join(tmpPath, 'scores-baseline.json');
    writeFileSync(scoresFile, JSON.stringify([makeResult('react_quickstart', 'gpt-5.2')]));

    const html = renderHtml(loadScores([scoresFile]), '2024-01-01 00:00');

    expect(html).toContain('react_quickstart');
    expect(html).toContain('gpt-5.2');
  });
});

// ── CSS class integration tests ───────────────────────────────────────────────

describe('renderHtml CSS class integration', () => {
  it('100% pass rate applies rate-excellent to card-score-value', () => {
    const html = renderHtml(
      [makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 1.0 })],
      '2024-01-01 00:00',
    );
    expect(html).toContain('class="rate-excellent card-score-value"');
  });

  it('50% pass rate (lower boundary of fair tier) applies rate-fair, not rate-poor', () => {
    const html = renderHtml(
      [makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 0.5 })],
      '2024-01-01 00:00',
    );
    expect(html).toContain('class="rate-fair card-score-value"');
    const body = html.slice(html.indexOf('</style>'));
    expect(body).not.toContain('rate-poor');
  });

  it('0% pass rate applies rate-poor to card-score-value', () => {
    const html = renderHtml(
      [makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 0.0 })],
      '2024-01-01 00:00',
    );
    expect(html).toContain('class="rate-poor card-score-value"');
  });

  it('overall grade A produces badge-a class on weighted-total badge', () => {
    const html = renderHtml(
      [
        makeResult('react_quickstart', 'gpt-5.2', 'baseline', {
          overall_grade: 'A',
          overall_score: 95.0,
          dimensions: [{ name: 'friction', score: 95.0, weight: 0.15, grade: 'A' }],
        }),
      ],
      '2024-01-01 00:00',
    );
    expect(html).toContain('class="grade-badge grade-badge--lg badge-a"');
  });

  it('overall grade F produces badge-df class (shared with D) on weighted-total badge', () => {
    const html = renderHtml(
      [
        makeResult('react_quickstart', 'gpt-5.2', 'baseline', {
          overall_grade: 'F',
          overall_score: 20.0,
          dimensions: [{ name: 'friction', score: 20.0, weight: 0.15, grade: 'F' }],
        }),
      ],
      '2024-01-01 00:00',
    );
    expect(html).toContain('class="grade-badge grade-badge--lg badge-df"');
  });
});

// ── Unified variant selector and comparison matrix tests ─────────────────────

describe('renderHtml variant selector', () => {
  it('renders one labelled selector for all variants', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('react_quickstart', 'gpt-5.2', 'agent'),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('<label for="filter-variant">Variant</label>');
    expect(html).toContain('<select id="filter-variant"');
    expect(html).toContain('<option value="baseline">baseline</option>');
    expect(html).toContain('<option value="agent">agent</option>');
    const body = html.slice(html.indexOf('</style>'));
    expect(body).not.toContain('mode-toggle-btn');
  });

  it('renders agent+Skills as a separate selector option', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { tools: ['Skills'] }),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('<option value="baseline">baseline</option>');
    expect(html).toContain('<option value="agent+Skills">agent+Skills</option>');
  });

  it('renders one summary panel per variant', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('react_quickstart', 'gpt-5.2', 'agent'),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('class="summary-panel active" data-variant="baseline"');
    expect(html).toContain('class="summary-panel" data-variant="agent" hidden');
  });

  it('uses semantic model row headers and eval column headers', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('swift_quickstart', 'gpt-5.2', 'baseline'),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('<th class="summary-eval-id" scope="row">gpt-5.2</th>');
    expect(html).toContain('class="summary-column-heading" scope="col"');
    expect(html).toContain('react_quickstart');
    expect(html).toContain('swift_quickstart');
  });
});

// ── Delta badge tests ─────────────────────────────────────────────────────────

describe('renderHtml delta badges', () => {
  it('shows positive delta for agent mode improvement over baseline', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 0.5 }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { grader_pass_rate: 0.75 }),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('delta-pos');
    expect(html).toContain('+25%');
  });

  it('shows negative delta for agent mode degradation from baseline', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 1.0 }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { grader_pass_rate: 0.75 }),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('delta-neg');
    expect(html).toContain('-25%');
  });

  it('no delta shown on baseline tab', () => {
    const results = [makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 1.0 })];
    const html = renderHtml(results, '2024-01-01 00:00');
    // Extract only the body content (after </style>) to avoid matching CSS class definitions
    const body = html.slice(html.indexOf('</style>'));
    expect(body).not.toContain('class="delta delta-pos"');
    expect(body).not.toContain('class="delta delta-neg"');
    expect(body).not.toContain('class="delta delta-zero"');
  });
});

// ── Dashboard hierarchy and run explorer tests ───────────────────────────────

describe('renderHtml analytics workspace', () => {
  it('renders the report hierarchy and summary KPIs', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', {
        grader_pass_rate: 0.5,
        total_cost_usd: 0.03,
        judge_cost_usd: 0.01,
      }),
      makeResult('swift_quickstart', 'claude-sonnet-4-6', 'baseline', {
        grader_pass_rate: 1,
        total_cost_usd: 0.02,
        judge_cost_usd: 0.005,
      }),
    ];
    const html = renderHtml(results, '2024-01-01 00:00');
    expect(html).toContain('<main class="dashboard-shell">');
    expect(html).toContain('aria-label="Report summary"');
    expect(html).toContain('<span>Runs</span><strong>2</strong>');
    expect(html).toContain('<span>Average pass rate</span><strong>75%</strong>');
    expect(html).toContain('<span>Total cost</span><strong>$0.0500</strong>');
    expect(html).toContain('<span>Models</span><strong>2</strong>');
    expect(html).toContain('id="comparison-title">Pass-rate comparison');
    expect(html).toContain('id="explorer-title">Run explorer');
  });

  it('labels average pass rate as covering only scored runs', () => {
    const html = renderHtml(
      [
        makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 1 }),
        makeResult('swift_quickstart', 'gpt-5.2', 'baseline', {
          status: 'error',
          grader_pass_rate: undefined,
        }),
      ],
      '2024-01-01 00:00',
    );
    expect(html).toContain('<span>Average pass rate</span><strong>100%</strong><small>across 1 scored run</small>');
  });

  it('renders searchable eval and model controls with a live result count', () => {
    const html = renderHtml([makeResult()], '2024-01-01 00:00');
    expect(html).toContain('role="search" aria-label="Filter runs"');
    expect(html).toContain('for="filter-search">Search runs</label>');
    expect(html).toContain('id="filter-eval"');
    expect(html).toContain('id="filter-model"');
    expect(html).toContain('id="result-count" class="result-count" aria-live="polite"');
    expect(html).toContain('id="clear-filters"');
    expect(html).toContain('No runs match these filters.');
  });

  it('renders native expandable diagnostics with all recorded detail types', () => {
    const html = renderHtml(
      [
        makeResult('react_quickstart', 'gpt-5.2', 'baseline', {
          graders_passed: 2,
          graders_total: 2,
          graders: [
            { kind: 'contains', name: 'Uses Auth0Provider', passed: true, detail: 'found' },
            { kind: 'judge', name: 'Is the integration complete?', passed: true, detail: 'Judge (test): Yes.' },
          ],
          dimensions: [{ name: 'correctness', score: 90, weight: 0.25, grade: 'A' }],
          overall_score: 90,
          overall_grade: 'A',
          turn_metrics: [
            {
              turn: 1,
              input_tokens: 10,
              output_tokens: 5,
              llm_latency: 1.2,
              cost_usd: 0.001,
              finish_reason: 'stop',
              tool_call_count: 1,
            },
          ],
          session_trace: [
            {
              step: 1,
              actionType: 'implementation',
              tool: 'write',
              args: { path: 'src/App.tsx' },
              duration: 0.2,
            },
          ],
          recommendations: {
            summary: 'One improvement',
            recommendations: [
              { category: 'efficiency', severity: 'low', issue: 'Extra step', suggestion: 'Combine it' },
            ],
          },
        }),
      ],
      '2024-01-01 00:00',
    );
    expect(html).toContain('<details class="run-card">');
    expect(html).toContain('<summary class="run-summary">');
    expect(html).toContain('aria-label="Score dimensions"');
    expect(html).toContain('<h4>Graders');
    expect(html).toContain('<h4>Judge</h4>');
    expect(html).toContain('<h4>Turn metrics</h4>');
    expect(html).toContain('<h4>Session trace</h4>');
    expect(html).toContain('<h4>Recommendations</h4>');
    expect(html).toContain('Uses Auth0Provider');
    expect(html).toContain('One improvement');
  });

  it('renders prominent escaped error diagnostics', () => {
    const html = renderHtml(
      [makeResult('react_quickstart', 'gpt-5.2', 'baseline', { status: 'error', error: '<unsafe>failed</unsafe>' })],
      '2024-01-01 00:00',
    );
    expect(html).toContain('class="run-card run-card--error"');
    expect(html).toContain('<h4>Error details</h4>');
    expect(html).toContain('&lt;unsafe&gt;failed&lt;/unsafe&gt;');
    expect(html).not.toContain('<unsafe>failed</unsafe>');
  });

  it('includes theme, matrix, and expandable-control accessibility labels', () => {
    const html = renderHtml([makeResult()], '2024-01-01 00:00');
    expect(html).toContain('id="theme-toggle" type="button" aria-label="Use dark theme" aria-pressed="false"');
    expect(html).toContain('aria-label="Scrollable pass-rate comparison matrix"');
    expect(html).toContain('<caption class="sr-only">Grader pass rates');
    expect(html).toContain('<span class="sr-only">Successful run:</span>');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('.filter-group:focus-within');
    expect(html).toContain('details:not([open]) > .run-diagnostics');
  });
});

// ── Embedded client behavior tests ───────────────────────────────────────────

describe('renderHtml embedded client', () => {
  it('initially filters run cards to the first variant and updates the result count', () => {
    const harness = runReportClient([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('swift_quickstart', 'claude-sonnet-4-6', 'baseline'),
      makeResult('react_quickstart', 'gpt-5.2', 'agent'),
    ]);

    expect(harness.element('filter-variant').value).toBe('baseline');
    expect(harness.document.cards.map((card) => card.hidden)).toEqual([false, false, true]);
    expect(harness.element('result-count').textContent).toBe('2 runs');
    expect(harness.element('empty-results').hidden).toBe(true);
  });

  it('switches the visible summary panel and run cards with the selected variant', () => {
    const harness = runReportClient([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('react_quickstart', 'gpt-5.2', 'agent'),
    ]);
    const variant = harness.element('filter-variant');

    variant.value = 'agent';
    variant.dispatch('change');

    const [baselinePanel, agentPanel] = harness.document.panels;
    expect(baselinePanel?.hidden).toBe(true);
    expect(baselinePanel?.classList.contains('active')).toBe(false);
    expect(agentPanel?.hidden).toBe(false);
    expect(agentPanel?.classList.contains('active')).toBe(true);
    expect(harness.document.cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(harness.element('result-count').textContent).toBe('1 run');
  });

  it('combines eval, model, and search filters and controls section and empty-state visibility', () => {
    const harness = runReportClient([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', {
        graders: [{ name: 'Unique provider check', passed: true }],
      }),
      makeResult('react_quickstart', 'claude-sonnet-4-6', 'baseline'),
      makeResult('swift_quickstart', 'gpt-5.2', 'baseline'),
    ]);
    const evalFilter = harness.element('filter-eval');
    const modelFilter = harness.element('filter-model');
    const searchFilter = harness.element('filter-search');

    evalFilter.value = 'react_quickstart';
    evalFilter.dispatch('change');
    modelFilter.value = 'gpt-5.2';
    modelFilter.dispatch('change');
    searchFilter.value = 'PROVIDER CHECK';
    searchFilter.dispatch('input');

    expect(harness.document.cards.map((card) => card.hidden)).toEqual([false, true, true]);
    expect(harness.document.sections.map((section) => section.hidden)).toEqual([false, true]);
    expect(harness.element('result-count').textContent).toBe('1 run');

    searchFilter.value = 'does-not-exist';
    searchFilter.dispatch('input');
    expect(harness.document.sections.every((section) => section.hidden)).toBe(true);
    expect(harness.element('result-count').textContent).toBe('0 runs');
    expect(harness.element('empty-results').hidden).toBe(false);
  });

  it('clears eval, model, and search filters and returns focus to search', () => {
    const harness = runReportClient([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('swift_quickstart', 'claude-sonnet-4-6', 'baseline'),
    ]);
    const evalFilter = harness.element('filter-eval');
    const modelFilter = harness.element('filter-model');
    const searchFilter = harness.element('filter-search');

    evalFilter.value = 'react_quickstart';
    modelFilter.value = 'gpt-5.2';
    searchFilter.value = 'missing';
    searchFilter.dispatch('input');
    harness.element('clear-filters').dispatch('click');

    expect(evalFilter.value).toBe('__all__');
    expect(modelFilter.value).toBe('__all__');
    expect(searchFilter.value).toBe('');
    expect(searchFilter.focused).toBe(true);
    expect(harness.document.cards.every((card) => !card.hidden)).toBe(true);
    expect(harness.element('result-count').textContent).toBe('2 runs');
    expect(harness.element('empty-results').hidden).toBe(true);
  });

  it('restores and persists theme changes', () => {
    const harness = runReportClient([makeResult()], 'dark');
    const themeToggle = harness.element('theme-toggle');

    expect(harness.document.documentElement.dataset.theme).toBe('dark');
    expect(themeToggle.getAttribute('aria-pressed')).toBe('true');
    expect(themeToggle.getAttribute('aria-label')).toBe('Use light theme');
    expect(themeToggle.themeLabel?.textContent).toBe('Light');

    themeToggle.dispatch('click');
    expect(harness.document.documentElement.dataset.theme).toBeUndefined();
    expect(themeToggle.getAttribute('aria-pressed')).toBe('false');
    expect(themeToggle.getAttribute('aria-label')).toBe('Use dark theme');
    expect(themeToggle.themeLabel?.textContent).toBe('Dark');
    expect(harness.localStorage.getItem('auth0-evals-theme')).toBe('light');
  });
});

// ── resultVariant tests ───────────────────────────────────────────────────────

describe('resultVariant', () => {
  it('returns mode for baseline', () => {
    expect(resultVariant(makeResult('r', 'm', 'baseline'))).toBe('baseline');
  });

  it('returns mode for agent with no tools', () => {
    expect(resultVariant(makeResult('r', 'm', 'agent', { tools: [] }))).toBe('agent');
  });

  it('returns mode+tools for agent with tools', () => {
    expect(resultVariant(makeResult('r', 'm', 'agent', { tools: ['Skills'] }))).toBe('agent+Skills');
  });

  it('handles missing tools field (backward compat)', () => {
    const r = makeResult('r', 'm', 'agent');
    delete r.tools;
    expect(resultVariant(r)).toBe('agent');
  });
});

// ── groupByVariant tests ──────────────────────────────────────────────────────

describe('groupByVariant', () => {
  it('groups results by variant, eval_id, model', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'baseline'),
      makeResult('react_quickstart', 'gpt-5.2', 'agent'),
    ];
    const grouped = groupByVariant(results);
    expect(grouped['baseline']['react_quickstart']['gpt-5.2']).toBeDefined();
    expect(grouped['agent']['react_quickstart']['gpt-5.2']).toBeDefined();
  });

  it('uses mode+tools as variant key for agent runs with tools', () => {
    const results = [makeResult('react_quickstart', 'gpt-5.2', 'agent', { tools: ['Skills'] })];
    const grouped = groupByVariant(results);
    expect(grouped['agent+Skills']['react_quickstart']['gpt-5.2']).toBeDefined();
    expect(grouped['agent']).toBeUndefined();
  });

  it('does not conflate agent runs with different tool configurations', () => {
    const results = [
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { tools: [] }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { tools: ['Skills'] }),
    ];
    const grouped = groupByVariant(results);
    expect(grouped['agent']['react_quickstart']['gpt-5.2']).toBeDefined();
    expect(grouped['agent+Skills']['react_quickstart']['gpt-5.2']).toBeDefined();
  });
});

// ── computeDeltas tests ───────────────────────────────────────────────────────

describe('computeDeltas', () => {
  it('computes positive delta correctly', () => {
    const variantGrouped = groupByVariant([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 0.5 }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { grader_pass_rate: 0.75 }),
    ]);
    const deltas = computeDeltas(variantGrouped);
    expect(deltas['agent']['react_quickstart']['gpt-5.2']).toBeCloseTo(0.25);
  });

  it('computes negative delta correctly', () => {
    const variantGrouped = groupByVariant([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 1.0 }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { grader_pass_rate: 0.75 }),
    ]);
    const deltas = computeDeltas(variantGrouped);
    expect(deltas['agent']['react_quickstart']['gpt-5.2']).toBeCloseTo(-0.25);
  });

  it('returns null delta when baseline is missing', () => {
    const variantGrouped = groupByVariant([
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { grader_pass_rate: 0.75 }),
    ]);
    const deltas = computeDeltas(variantGrouped);
    expect(deltas['agent']['react_quickstart']['gpt-5.2']).toBeNull();
  });

  it('computes delta for agent+Skills variant independently from agent', () => {
    const variantGrouped = groupByVariant([
      makeResult('react_quickstart', 'gpt-5.2', 'baseline', { grader_pass_rate: 0.5 }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { tools: [], grader_pass_rate: 0.6 }),
      makeResult('react_quickstart', 'gpt-5.2', 'agent', { tools: ['Skills'], grader_pass_rate: 1.0 }),
    ]);
    const deltas = computeDeltas(variantGrouped);
    expect(deltas['agent']['react_quickstart']['gpt-5.2']).toBeCloseTo(0.1);
    expect(deltas['agent+Skills']['react_quickstart']['gpt-5.2']).toBeCloseTo(0.5);
  });
});
