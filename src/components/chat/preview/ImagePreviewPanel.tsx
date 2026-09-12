// ImagePreviewPanel.tsx - Body content for the panel variant of ImagePreview.
// Renders image/pdf/code/text/doc/placeholder content inside the
// scrollable panel-body region. The chrome around it (overlay, close
// button, header, animation) lives in ImagePreview.tsx.
//
// Lifted from the legacy AttachmentPreviewModal.tsx so the same dispatch
// logic survives the modal unification (Plan 511). All inner element
// class names start with `image-preview-` instead of `attachment-preview-`,
// matching the unified CSS in src/styles/preview.css.

'use client';

import React from 'react';
import { FileTextIcon, DownloadSimpleIcon as DownloadIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import type { FileAttachment } from '@/types/message';
import { rewriteMediaSrc } from '../markdownComponents';

export type PreviewType = 'image' | 'pdf' | 'code' | 'doc' | 'text' | 'unknown';

interface ImagePreviewPanelProps {
  attachment: FileAttachment | null;
  pastedContent?: { id: string; content: string; preview: string } | null;
  /** When true, only render the body content (text / code / pdf / doc)
   *  and skip the image slot. Default false. */
  bodyOnly?: boolean;
}

const CODE_EXTS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'py', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'r', 'm', 'sql',
  'yaml', 'yml', 'xml', 'sh', 'bash', 'zsh', 'ps1', 'vim', 'lua',
  'perl', 'dart', 'elm', 'haskell', 'clojure', 'erlang', 'elixir',
  'ocaml', 'fsharp', 'groovy', 'julia', 'matlab', 'sas', 'stata',
  'spss', 'lisp', 'scheme', 'racket', 'fortran', 'cobol', 'pascal',
  'delphi', 'ada', 'vhdl', 'verilog', 'systemverilog', 'tcl', 'awk',
  'sed', 'makefile', 'dockerfile', 'nginx', 'apache', 'ini', 'cfg',
  'conf', 'properties', 'gradle', 'maven', 'cmake', 'bazel', 'buck',
  'podfile', 'gemfile', 'cargo', 'composer', 'package', 'webpack',
  'rollup', 'vite', 'esbuild', 'babel', 'eslint', 'prettier',
  'stylelint', 'postcss', 'tailwind', 'sass', 'less', 'stylus',
  'graphql', 'protobuf', 'thrift', 'grpc', 'openapi', 'swagger',
  'postman', 'insomnia', 'hoppscotch', 'bruno', 'k6', 'artillery',
  'locust', 'jmeter', 'gatling', 'cypress', 'playwright', 'selenium',
  'webdriver', 'puppeteer', 'cheerio', 'jsdom', 'enzyme',
  'testing-library', 'jest', 'vitest', 'mocha', 'chai', 'sinon',
  'nyc', 'istanbul', 'c8', 'codecov', 'coveralls', 'sonarqube',
  'codeclimate', 'codacy', 'deepsource', 'snyk', 'dependabot',
  'renovate', 'greenkeeper', 'semantic-release', 'standard-version',
  'commitlint', 'husky', 'lint-staged', 'pre-commit', 'tox', 'nox',
  'poetry', 'pipenv', 'conda', 'mamba', 'virtualenv', 'pyenv',
  'rbenv', 'rvm', 'nvm', 'fnm', 'volta', 'asdf', 'sdkman', 'jenv',
  'gvm', 'rustup', 'cargo', 'stack', 'ghc', 'cabal', 'opam', 'esy',
  'dune', 'mix', 'hex', 'rebar', 'erlang.mk', 'rabbitmq', 'kafka',
  'redis', 'memcached', 'mongodb', 'postgres', 'mysql', 'sqlite',
  'mariadb', 'cockroachdb', 'cassandra', 'dynamodb', 'firebase',
  'supabase', 'prisma', 'sequelize', 'typeorm', 'mongoose',
  'sqlalchemy', 'peewee', 'tortoise', 'pony', 'datasette',
  'metabase', 'redash', 'superset', 'grafana', 'prometheus',
  'influxdb', 'timescaledb', 'clickhouse', 'elasticsearch', 'solr',
  'meilisearch', 'algolia', 'typesense', 'sonic', 'quickwit',
  'tantivy', 'bleve', 'bluge', 'zinc', 'meili', 'manticore',
  'sphinx', 'redisearch', 'arangodb', 'neo4j', 'orientdb',
  'janusgraph', 'tigergraph', 'dgraph', 'cayley', 'gaffer',
  'accumulo', 'hbase', 'bigtable', 'couchdb', 'pouchdb', 'rxdb',
  'watermelondb', 'realm', 'objectbox', 'isar', 'hive', 'sembast',
  'floor', 'moor', 'drift', 'sqlflite', 'sqflite', 'hive_ce',
  'objectbox_sync', 'realm_flex', 'atlas', 'cosmos', 'firestore',
  'bigquery', 'snowflake', 'redshift', 'synapse', 'databricks',
  'dbt', 'fivetran', 'airbyte', 'meltano', 'prefect', 'dagster',
  'kestra', 'temporal', 'cadence', 'conductor', 'zeebe', 'camunda',
  'activiti', 'flowable', 'bonita', 'jBPM', 'drools', 'optaplanner',
  'timefold', 'or-tools', 'gurobi', 'cplex', 'xpress', 'mosek',
  'scip', 'cbc', 'glpk', 'lpsolve', 'highs', 'ipopt', 'knitro',
  'baron', 'octeract', 'couenne', 'bonmin', 'shot', 'mindtpy',
  'dice', 'deco', 'decogo', 'alphaecp', 'sbb', 'dicopt', 'minlp',
  'miqp', 'miqcp', 'mpec', 'nlp', 'qp', 'qcqp', 'socp', 'sdp',
  'milp', 'lp', 'mip', 'cp', 'csp', 'sat', 'smt', 'maxsat', 'pb',
  'qbf', 'fol', 'hol', 'z3', 'cvc', 'yices', 'mathsat', 'verit',
  'opensmt', 'smtinterpol', 'alt-ergo', 'gappa', 'why3', 'frama-c',
  'astree', 'polyspace', 'code sonar', 'coverity', 'klocwork',
  'understand', 'source insight', 'sourcetrail', 'codeql',
  'semgrep', 'bandit', 'safety', 'pip-audit', 'npm audit',
  'yarn audit', 'pnpm audit', 'cargo audit', 'go audit',
  'bundle audit', 'gem audit', 'pipenv check', 'poetry check',
  'conda audit', 'snyk test', 'snyk code', 'snyk container',
  'snyk iac', 'checkov', 'tfsec', 'terrascan', 'kics', 'sonarcloud',
  'scrutinizer', 'insight.io', 'deepscan', 'jshint', 'jscs',
  'jslint', 'tslint', 'black', 'yapf', 'autopep8', 'isort',
  'flake8', 'pylint', 'mypy', 'pyright', 'pytype', 'prospector',
  'radon', 'xenon', 'vulture', 'pydocstyle', 'darglint',
  'interrogate', 'mkdocstrings', 'pdoc', 'pydoctor', 'doxygen',
  'javadoc', 'jsdoc', 'typedoc', 'esdoc', 'documentation.js',
  'api-extractor', 'api-documenter', 'tsc', 'swc', 'parcel',
  'snowpack', 'wmr', 'microbundle', 'tsup', 'unbuild', 'mkdist',
  'bumpp', 'changelogithub', 'changesets', 'commitizen',
  'husky', 'tox', 'nox', 'pipenv', 'mamba', 'rbenv', 'rvm', 'nvm',
  'fnm', 'volta', 'asdf', 'sdkman', 'jenv', 'gvm', 'rustup',
  'cargo', 'stack', 'ghc', 'cabal', 'opam', 'esy', 'dune', 'mix',
  'hex', 'rebar', 'erlang.mk',
]);

function getPreviewType(attachment: FileAttachment): PreviewType {
  const ext = attachment.name.split('.').pop()?.toLowerCase() || '';
  if (attachment.type.startsWith('image/')) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'pptx', 'xlsx'].includes(ext)) return 'doc';
  if (CODE_EXTS.has(ext)) return 'code';
  if (['txt', 'md'].includes(ext)) return 'text';
  return 'unknown';
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function panelTitle(attachment: FileAttachment | null | undefined, pastedContent: { content: string } | null | undefined): string {
  if (pastedContent) return 'Pasted Content';
  return attachment?.name || 'Preview';
}

export function panelSubtitle(attachment: FileAttachment | null | undefined, pastedContent: { content: string } | null | undefined): string {
  if (pastedContent) {
    const len = pastedContent.content.length;
    return `${len} characters`;
  }
  if (!attachment) return '';
  const parts: string[] = [];
  if (attachment.size > 0) {
    parts.push(formatFileSize(attachment.size));
  }
  const ext = attachment.name.split('.').pop()?.toUpperCase();
  if (ext) parts.push(ext);
  return parts.join(' · ');
}

function PanelImageBody({ attachment }: { attachment: FileAttachment }) {
  const rawSrc = attachment.displayUrl || attachment.url || attachment.path;
  const src = rawSrc ? rewriteMediaSrc(rawSrc) : '';
  return (
    <img
      src={src}
      alt={attachment.name}
      className="image-preview-panel-img"
    />
  );
}

function PanelCodeBody({ content, filename }: { content: string; filename: string }) {
  return (
    <div className="image-preview-panel-code-wrapper">
      <div className="image-preview-panel-code-header">
        <span className="image-preview-panel-code-filename">{filename}</span>
      </div>
      <pre className="image-preview-panel-code-content">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function PanelTextBody({ content, filename }: { content: string; filename?: string }) {
  return (
    <div className="image-preview-panel-text-wrapper">
      {filename && (
        <div className="image-preview-panel-text-header">
          <span className="image-preview-panel-text-filename">{filename}</span>
        </div>
      )}
      <pre className="image-preview-panel-text-content">{content}</pre>
    </div>
  );
}

function PanelPdfBody({ attachment }: { attachment: FileAttachment }) {
  const handleOpenInBrowser = () => {
    if (attachment.path && window.electronAPI?.shell?.openPath) {
      window.electronAPI.shell.openPath(attachment.path);
    } else if (attachment.url) {
      window.open(attachment.url, '_blank');
    }
  };

  return (
    <div className="image-preview-panel-pdf-wrapper">
      <div className="image-preview-panel-pdf-header">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleOpenInBrowser}
          className="image-preview-panel-pdf-open-btn"
          title="Open in browser"
        >
          <DownloadIcon size={14} />
          <span>Open</span>
        </Button>
      </div>
      <div className="image-preview-panel-pdf-content">
        {attachment.thumbnail ? (
          <img
            src={rewriteMediaSrc(attachment.thumbnail)}
            alt={attachment.name}
            className="image-preview-panel-pdf-thumbnail"
          />
        ) : (
          <div className="image-preview-panel-pdf-placeholder">
            <FileTextIcon size={48} />
            <span>PDF Document</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelDocBody({ attachment }: { attachment: FileAttachment }) {
  return (
    <div className="image-preview-panel-doc-wrapper">
      <div className="image-preview-panel-doc-header">
        <span className="image-preview-panel-doc-filename">{attachment.name}</span>
      </div>
      <div className="image-preview-panel-doc-content">
        {attachment.text ? (
          <pre className="image-preview-panel-doc-text">{attachment.text}</pre>
        ) : attachment.thumbnail ? (
          <img
            src={rewriteMediaSrc(attachment.thumbnail)}
            alt={attachment.name}
            className="image-preview-panel-doc-thumbnail"
          />
        ) : (
          <div className="image-preview-panel-doc-placeholder">
            <FileTextIcon size={48} />
            <span>Word Document</span>
            <span className="image-preview-panel-doc-hint">No preview available</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelUnknownBody({ attachment }: { attachment: FileAttachment }) {
  return (
    <div className="image-preview-panel-unknown">
      <FileTextIcon size={48} />
      <span>No preview available for this file type</span>
    </div>
  );
}

export function ImagePreviewPanel({ attachment, pastedContent, bodyOnly }: ImagePreviewPanelProps) {
  const previewType: PreviewType = pastedContent
    ? 'text'
    : attachment
      ? getPreviewType(attachment)
      : 'unknown';

  // For text/code/pdf/doc, the body fills the panel-body region (no image
  // slot above it). For images, the body is the image itself.
  if (previewType === 'image' && attachment && !bodyOnly) {
    return <PanelImageBody attachment={attachment} />;
  }
  if (previewType === 'image' && attachment && bodyOnly) {
    return null;
  }
  if (previewType === 'pdf' && attachment) {
    return <PanelPdfBody attachment={attachment} />;
  }
  if (previewType === 'doc' && attachment) {
    return <PanelDocBody attachment={attachment} />;
  }
  if (previewType === 'code' && attachment) {
    return (
      <PanelCodeBody
        content={attachment.text || 'No content available'}
        filename={attachment.name}
      />
    );
  }
  if (previewType === 'text') {
    return (
      <PanelTextBody
        content={pastedContent?.content || attachment?.text || attachment?.name || ''}
        filename={pastedContent ? undefined : attachment?.name}
      />
    );
  }
  if (attachment) {
    return <PanelUnknownBody attachment={attachment} />;
  }
  return null;
}