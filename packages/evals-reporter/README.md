# @a0/evals-reporter

Report generation and analytics for the Auth0 eval framework. Turns the JSON score files produced by `a0-eval` into a self-contained HTML report, and provides the processing helpers used to group and diff results.

Part of the [`auth0-evals`](https://github.com/auth0/auth0-evals) monorepo.

## What it provides

- **`renderHtml(results, generatedAt)`** — render a full HTML report from an array of job results.
- **Processors** — `loadScores`, `groupResults`, `groupByVariant`, `computeDeltas`, `resultVariant`, and the `MODES` constant for building custom views over results.
- **Nunjucks filters** — `registerFilters` / `ALL_FILTERS` for the report templates.

## Usage

```ts
import { loadScores, renderHtml } from '@a0/evals-reporter';
import { writeFileSync } from 'node:fs';

const results = loadScores(['scores-latest.json']);
const html = renderHtml(results, new Date().toISOString());
writeFileSync('report.html', html);
```

Most consumers generate reports via the CLI instead:

```bash
a0-eval report --input scores-latest.json --output report.html
```

## Generated dashboard

The self-contained report opens as a responsive analytics workspace with summary KPIs, a variant-aware pass-rate matrix, and a searchable run explorer. The shared variant selector updates both views; eval and model filters narrow the explorer, and each result expands to show its graders, score dimensions, judge output, metrics, trace, recommendations, or error details.

Reports default to a light Auth0-inspired theme and include a persistent dark-theme toggle. All styles and behavior are embedded in the HTML, so generated reports do not require network access or external assets.

See the [monorepo README](https://github.com/auth0/auth0-evals) for the full framework guide.

## License

Apache-2.0 © Okta, Inc. See [LICENSE](https://github.com/auth0/auth0-evals/blob/main/LICENSE).
