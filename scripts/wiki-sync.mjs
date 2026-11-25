#!/usr/bin/env node
/**
 * Mirrors each package README, the ADR index and the reference docs onto pages of the GitHub wiki.
 *
 * Every README.md under packages/*, adapters/*, editors/* and actions/* becomes one page in a
 * local clone of the wiki. An `@mmmnt/<pkg>` package is written to `@mmmnt-<pkg>.md`; the VS
 * Code extension (`editors/vscode`) to `VS-Code-Extension.md`; the pr-report GitHub Action
 * (`actions/pr-report`) to `PR-Report-Action.md`. Each of DOC_PAGES below (the ADR index, the
 * grammar reference, the evidence bundle) is written to its page when its file exists; when it
 * does not, an existing page is left as it is.
 *
 * Relative links are rewritten so they work from the wiki:
 *
 *   - a link to another package README (`../core/README.md`, `../core`) becomes
 *     a link to that package's wiki page; an anchor is kept
 *   - a link to any other file or directory in the repo becomes an absolute
 *     `https://github.com/<repo>/blob/<ref>/<path>` URL (`tree` for a directory);
 *     from the ADR index, `ADR-040-....md` becomes `.../blob/<ref>/docs/adr/ADR-040-....md`
 *   - an image becomes a `https://raw.githubusercontent.com/<repo>/<ref>/<path>` URL
 *   - an anchor on the same page (`#exit-codes`) and an absolute URL are left alone
 *
 * Links inside fenced code blocks and inline code are not touched.
 *
 * Each page starts with one line saying which file it is generated from.
 * A page that starts with that line is deleted when no source writes it any
 * more: the file it names is gone, or that file is now written to another page.
 * A page without that line (a hand-written page) is never touched.
 * The script only writes files; committing and pushing is the caller's job.
 *
 * USAGE
 *
 *   node scripts/wiki-sync.mjs --wiki-dir <path> [--dry-run] [--repo <owner/name>] [--ref <branch>]
 *
 *   --wiki-dir  a clone of https://github.com/<repo>.wiki.git (required)
 *   --dry-run   print what would change and write nothing
 *   --repo      the repository links point at (default: $GITHUB_REPOSITORY or mmmnt/feature)
 *   --ref       the branch links point at (default: main)
 *
 * EXIT CODES
 *
 *   0  pages written (or, with --dry-run, the changes printed)
 *   1  bad arguments, or no package README was found
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages whose wiki page is not named after the npm package. */
const PAGE_BY_DIRECTORY = {
  'editors/vscode': 'VS-Code-Extension',
  'actions/pr-report': 'PR-Report-Action',
};

/** The directories whose children are packages, each with its own README. */
const PACKAGE_ROOTS = ['packages', 'adapters', 'editors', 'actions'];

const NOTE_PREFIX = '> This page is generated from';

/** The note on the first line of a generated page; captures the source file it names. */
const NOTE_SOURCE = /^> This page is generated from \[([^\]]+)\]/;

/** Repo documents mirrored onto a page each, when the file exists. */
const DOC_PAGES = [
  { page: 'ADR-Index', source: 'docs/adr/README.md', baseDir: 'docs/adr' },
  { page: 'Grammar-Reference', source: 'docs/grammar-reference.md', baseDir: 'docs' },
  { page: 'Evidence-Bundle', source: 'docs/evidence-bundle.md', baseDir: 'docs' },
];

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico)$/i;

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'wiki-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY || 'mmmnt/feature' },
      ref: { type: 'string', default: 'main' },
    },
  });
  if (!values['wiki-dir']) {
    throw new Error('--wiki-dir <path> is required');
  }
  const wikiDir = resolve(values['wiki-dir']);
  if (!existsSync(wikiDir) || !statSync(wikiDir).isDirectory()) {
    throw new Error(`--wiki-dir ${wikiDir} is not a directory`);
  }
  return { wikiDir, dryRun: values['dry-run'], repo: values.repo, ref: values.ref };
}

/** The wiki page name for a package directory, or undefined when it has no page. */
function pageNameFor(directory, packageName) {
  if (PAGE_BY_DIRECTORY[directory]) return PAGE_BY_DIRECTORY[directory];
  if (packageName?.startsWith('@mmmnt/')) return packageName.replace('/', '-');
  return undefined;
}

function readPackageName(packageDir) {
  const manifest = join(packageDir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  return JSON.parse(readFileSync(manifest, 'utf8')).name;
}

/** Every package with a README and a wiki page name, keyed by its repo path (adapters/fs). */
function discoverPackages(repoRoot) {
  const packages = new Map();
  for (const root of PACKAGE_ROOTS) {
    const rootDir = join(repoRoot, root);
    if (!existsSync(rootDir)) continue;
    for (const name of readdirSync(rootDir).sort()) {
      const directory = `${root}/${name}`;
      const packageDir = join(repoRoot, directory);
      if (!statSync(packageDir).isDirectory() || !existsSync(join(packageDir, 'README.md'))) continue;
      const page = pageNameFor(directory, readPackageName(packageDir));
      if (!page) {
        console.warn(`skipped ${directory}: no wiki page name for it`);
        continue;
      }
      packages.set(directory, { directory, page, source: `${directory}/README.md`, baseDir: directory });
    }
  }
  return packages;
}

/** Every page to write: one per package, and one per DOC_PAGES entry whose file exists. */
function discoverSources(repoRoot, packages) {
  const sources = [...packages.values()];
  for (const doc of DOC_PAGES) if (existsSync(join(repoRoot, doc.source))) sources.push(doc);
  return sources;
}

function splitTarget(target) {
  const hash = target.indexOf('#');
  if (hash === -1) return { path: target, anchor: '' };
  return { path: target.slice(0, hash), anchor: target.slice(hash) };
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/** The package directory a repo path points at, when it is a package README or the package root. */
function packageOf(repoPath, packages) {
  const match = new RegExp(`^((?:${PACKAGE_ROOTS.join('|')})/[^/]+)/?(README\\.md)?$`).exec(repoPath);
  if (!match) return undefined;
  return packages.get(match[1]);
}

function repoUrl(repoPath, ctx, { image }) {
  if (image) return `https://raw.githubusercontent.com/${ctx.repo}/${ctx.ref}/${repoPath}`;
  const full = join(ctx.repoRoot, repoPath);
  const kind = existsSync(full) && statSync(full).isDirectory() ? 'tree' : 'blob';
  return `https://github.com/${ctx.repo}/${kind}/${ctx.ref}/${repoPath}`;
}

/** Rewrites one link target found in the source file, relative to `ctx.baseDir`. */
function rewriteTarget(target, ctx, { image = false } = {}) {
  if (target === '' || target.startsWith('#') || isExternal(target)) return target;
  const { path, anchor } = splitTarget(target);
  const repoPath = posix.normalize(posix.join(ctx.baseDir, path)).replace(/\/$/, '');
  if (repoPath.startsWith('..')) return target;
  const linkedPackage = image ? undefined : packageOf(repoPath, ctx.packages);
  if (linkedPackage) return `${linkedPackage.page}${anchor}`;
  const treatAsImage = image || IMAGE_EXTENSIONS.test(repoPath);
  return `${repoUrl(repoPath, ctx, { image: treatAsImage })}${anchor}`;
}

/** Rewrites inline links, images, reference definitions and HTML src/href in one line of prose. */
function rewriteProse(text, ctx) {
  const target = String.raw`\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)`;
  return (
    text
      .replace(
        new RegExp(String.raw`(!?)\[([^\[\]]*)\]` + target, 'g'),
        (_m, bang, label, href, title) => {
          const rewritten = rewriteTarget(href, ctx, { image: bang === '!' });
          return `${bang}[${label}](${rewritten}${title})`;
        },
      )
      // A linked image, [![alt](img)](href): the image was rewritten above, now the outer link.
      .replace(
        new RegExp(String.raw`\[(!\[[^\[\]]*\]\([^)]*\))\]` + target, 'g'),
        (_m, image, href, title) => {
          return `[${image}](${rewriteTarget(href, ctx)}${title})`;
        },
      )
      .replace(
        /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/,
        (_m, head, target) => head + rewriteTarget(target, ctx),
      )
      .replace(
        /\b(src|srcset)="([^"]+)"/g,
        (_m, attr, target) => `${attr}="${rewriteTarget(target, ctx, { image: true })}"`,
      )
      .replace(/\bhref="([^"]+)"/g, (_m, target) => `href="${rewriteTarget(target, ctx)}"`)
  );
}

/** Rewrites a line outside code fences. Inline code is masked first, so nothing inside it changes. */
function rewriteLine(line, ctx) {
  const spans = [];
  const masked = line.replace(/`+[^`]*`+/g, (span) => `\u0000${spans.push(span) - 1}\u0000`);
  return rewriteProse(masked, ctx).replace(
    /\u0000(\d+)\u0000/g,
    (_m, index) => spans[Number(index)],
  );
}

function fenceOf(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return match ? match[1] : undefined;
}

/** Rewrites every link in a source file, skipping fenced code blocks. */
export function rewriteReadme(markdown, ctx) {
  let openFence;
  return markdown
    .split('\n')
    .map((line) => {
      const fence = fenceOf(line);
      if (openFence) {
        if (fence && fence[0] === openFence[0] && fence.length >= openFence.length)
          openFence = undefined;
        return line;
      }
      if (fence) {
        openFence = fence;
        return line;
      }
      return rewriteLine(line, ctx);
    })
    .join('\n');
}

function noteFor(source, ctx) {
  const url = `https://github.com/${ctx.repo}/blob/${ctx.ref}/${source.source}`;
  return `${NOTE_PREFIX} [${source.source}](${url}). Edit that file; changes made to this page are overwritten.`;
}

/** One wiki page from one source: a package README or one of DOC_PAGES. */
export function renderPage(source, text, ctx) {
  const body = rewriteReadme(text, { ...ctx, baseDir: source.baseDir });
  return `${noteFor(source, ctx)}\n\n${body.replace(/\s*$/, '\n')}`;
}

/** A rough size of a change: lines only in the old page, lines only in the new one. */
function lineDelta(before, after) {
  const counts = new Map();
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return { added, removed };
}

function planPages(ctx) {
  const plan = [];
  for (const source of ctx.sources) {
    const file = join(ctx.wikiDir, `${source.page}.md`);
    const next = renderPage(source, readFileSync(join(ctx.repoRoot, source.source), 'utf8'), ctx);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (current === next) plan.push({ action: 'unchanged', file, source: source.source });
    else
      plan.push({
        action: current === undefined ? 'create' : 'update',
        file,
        next,
        current,
        source: source.source,
      });
  }
  return plan;
}

/**
 * Generated pages no source writes any more. A page counts as generated only when its
 * first line is the note. It is stale when the file the note names is gone from the
 * repo, or is a source now written to another page (a renamed page).
 */
function planStale(ctx) {
  const live = new Set(ctx.sources.map((source) => `${source.page}.md`));
  const written = new Set(ctx.sources.map((source) => source.source));
  return readdirSync(ctx.wikiDir)
    .filter((name) => name.endsWith('.md') && !live.has(name))
    .filter((name) => {
      const named = NOTE_SOURCE.exec(readFileSync(join(ctx.wikiDir, name), 'utf8'));
      if (!named) return false;
      return written.has(named[1]) || !existsSync(join(ctx.repoRoot, named[1]));
    })
    .map((name) => ({ action: 'delete', file: join(ctx.wikiDir, name) }));
}

function describe(step, ctx) {
  const name = relative(ctx.wikiDir, step.file);
  if (step.action === 'unchanged' || step.action === 'delete')
    return `${step.action.padEnd(9)} ${name}`;
  const { added, removed } = lineDelta(step.current ?? '', step.next);
  return `${step.action.padEnd(9)} ${name}  (from ${step.source}; +${added} -${removed} lines)`;
}

function apply(step) {
  if (step.action === 'delete') unlinkSync(step.file);
  else if (step.action !== 'unchanged') writeFileSync(step.file, step.next);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const packages = discoverPackages(REPO_ROOT);
  if (packages.size === 0) throw new Error(`no package README.md found under ${PACKAGE_ROOTS.join(', ')}`);
  const ctx = {
    ...options,
    repoRoot: REPO_ROOT,
    packages,
    sources: discoverSources(REPO_ROOT, packages),
  };
  const plan = [...planPages(ctx), ...planStale(ctx)];
  for (const step of plan) {
    console.log(describe(step, ctx));
    if (!ctx.dryRun) apply(step);
  }
  const changed = plan.filter((step) => step.action !== 'unchanged').length;
  const verb = ctx.dryRun ? 'would change' : 'changed';
  console.log(
    `${plan.length} page(s) checked; ${changed} ${verb}${ctx.dryRun ? ' (dry run, nothing written)' : ''}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`wiki-sync: ${error.message}`);
    process.exit(1);
  }
}
