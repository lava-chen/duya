// AttachmentPreviewModal.tsx - Universal attachment preview modal
// Supports: images, PDFs, code files, Word docs, pasted text

'use client';

import React, { useEffect, useMemo } from 'react';
import { XIcon, FileTextIcon, DownloadSimpleIcon as DownloadIcon } from '@/components/icons';
import type { FileAttachment } from '@/types/message';

export type PreviewType = 'image' | 'pdf' | 'code' | 'doc' | 'text' | 'unknown';

interface AttachmentPreviewModalProps {
  attachment: FileAttachment | null;
  pastedContent?: { id: string; content: string; preview: string } | null;
  onClose: () => void;
}

function getPreviewType(attachment: FileAttachment): PreviewType {
  const ext = attachment.name.split('.').pop()?.toLowerCase() || '';
  if (attachment.type.startsWith('image/')) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return 'doc';
  if (['txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'r', 'm', 'sql', 'yaml', 'yml', 'xml', 'sh', 'bash', 'zsh', 'ps1', 'vim', 'lua', 'perl', 'dart', 'elm', 'haskell', 'clojure', 'erlang', 'elixir', 'ocaml', 'fsharp', 'groovy', 'julia', 'matlab', 'sas', 'stata', 'spss', 'lisp', 'scheme', 'racket', 'fortran', 'cobol', 'pascal', 'delphi', 'ada', 'vhdl', 'verilog', 'systemverilog', 'tcl', 'awk', 'sed', 'makefile', 'dockerfile', 'nginx', 'apache', 'ini', 'cfg', 'conf', 'properties', 'gradle', 'maven', 'cmake', 'bazel', 'buck', 'podfile', 'gemfile', 'cargo', 'composer', 'package', 'webpack', 'rollup', 'vite', 'esbuild', 'babel', 'eslint', 'prettier', 'stylelint', 'postcss', 'tailwind', 'sass', 'less', 'stylus', 'graphql', 'protobuf', 'thrift', 'grpc', 'openapi', 'swagger', 'postman', 'insomnia', 'hoppscotch', 'bruno', 'k6', 'artillery', 'locust', 'jmeter', 'gatling', 'cypress', 'playwright', 'selenium', 'webdriver', 'puppeteer', 'cheerio', 'jsdom', 'enzyme', 'testing-library', 'jest', 'vitest', 'mocha', 'chai', 'sinon', 'nyc', 'istanbul', 'c8', 'codecov', 'coveralls', 'sonarqube', 'codeclimate', 'codacy', 'deepsource', 'snyk', 'dependabot', 'renovate', 'greenkeeper', 'semantic-release', 'standard-version', 'commitlint', 'husky', 'lint-staged', 'pre-commit', 'tox', 'nox', 'poetry', 'pipenv', 'conda', 'mamba', 'virtualenv', 'pyenv', 'rbenv', 'rvm', 'nvm', 'fnm', 'volta', 'asdf', 'sdkman', 'jenv', 'gvm', 'rustup', 'cargo', 'stack', 'ghc', 'cabal', 'opam', 'esy', 'dune', 'mix', 'hex', 'rebar', 'erlang.mk', 'rabbitmq', 'kafka', 'redis', 'memcached', 'mongodb', 'postgres', 'mysql', 'sqlite', 'mariadb', 'cockroachdb', 'cassandra', 'dynamodb', 'firebase', 'supabase', 'prisma', 'sequelize', 'typeorm', 'mongoose', 'sqlalchemy', 'peewee', 'tortoise', 'pony', 'datasette', 'metabase', 'redash', 'superset', 'grafana', 'prometheus', 'influxdb', 'timescaledb', 'clickhouse', 'elasticsearch', 'solr', 'meilisearch', 'algolia', 'typesense', 'sonic', 'quickwit', 'tantivy', 'bleve', 'bluge', 'zinc', 'meili', 'manticore', 'sphinx', 'redisearch', 'arangodb', 'neo4j', 'orientdb', 'janusgraph', 'tigergraph', 'dgraph', 'cayley', 'gaffer', 'accumulo', 'hbase', 'bigtable', 'couchdb', 'pouchdb', 'rxdb', 'watermelondb', 'realm', 'objectbox', 'isar', 'hive', 'sembast', 'floor', 'moor', 'drift', 'sqlflite', 'sqflite', 'hive_ce', 'objectbox_sync', 'realm_flex', 'atlas', 'cosmos', 'dynamodb', 'firestore', 'bigquery', 'snowflake', 'redshift', 'synapse', 'databricks', 'dbt', 'fivetran', 'airbyte', 'meltano', 'prefect', 'dagster', 'kestra', 'temporal', 'cadence', 'conductor', 'zeebe', 'camunda', 'activiti', 'flowable', 'bonita', 'jBPM', 'drools', 'optaplanner', 'timefold', 'or-tools', 'gurobi', 'cplex', 'xpress', 'mosek', 'scip', 'cbc', 'glpk', 'lpsolve', 'highs', 'ipopt', 'knitro', 'baron', 'octeract', 'couenne', 'bonmin', 'shot', 'mindtpy', 'dice', 'deco', 'decogo', 'shot', 'alphaecp', 'sbb', 'dicopt', 'minlp', 'miqp', 'miqcp', 'mpec', 'nlp', 'qp', 'qcqp', 'socp', 'sdp', 'milp', 'lp', 'mip', 'cp', 'csp', 'sat', 'smt', 'maxsat', 'pb', 'qbf', 'fol', 'hol', 'z3', 'cvc', 'yices', 'mathsat', 'verit', 'opensmt', 'smtinterpol', 'alt-ergo', 'gappa', 'why3', 'frama-c', 'astree', 'polyspace', 'code sonar', 'coverity', 'klocwork', 'understand', 'source insight', 'sourcetrail', 'codeql', 'semgrep', 'bandit', 'safety', 'pip-audit', 'npm audit', 'yarn audit', 'pnpm audit', 'cargo audit', 'go audit', 'bundle audit', 'gem audit', 'pipenv check', 'poetry check', 'conda audit', 'snyk test', 'snyk code', 'snyk container', 'snyk iac', 'checkov', 'tfsec', 'terrascan', 'kics', 'semgrep', 'codacy', 'deepsource', 'codeclimate', 'sonarcloud', 'sonarqube', 'coveralls', 'codecov', 'codeconv', 'scrutinizer', 'insight.io', 'deepscan', 'jshint', 'jscs', 'jslint', 'eslint', 'tslint', 'stylelint', 'prettier', 'black', 'yapf', 'autopep8', 'isort', 'flake8', 'pylint', 'mypy', 'pyright', 'pytype', 'bandit', 'prospector', 'radon', 'xenon', 'vulture', 'pydocstyle', 'darglint', 'interrogate', 'mkdocstrings', 'sphinx', 'pdoc', 'pydoctor', 'doxygen', 'javadoc', 'jsdoc', 'typedoc', 'esdoc', 'documentation.js', 'api-extractor', 'api-documenter', 'tsc', 'swc', 'esbuild', 'rollup', 'webpack', 'parcel', 'vite', 'snowpack', 'wmr', 'microbundle', 'tsup', 'unbuild', 'mkdist', 'bumpp', 'changelogithub', 'changesets', 'semantic-release', 'standard-version', 'commitizen', 'commitlint', 'husky', 'lint-staged', 'pre-commit', 'tox', 'nox', 'poetry', 'pipenv', 'conda', 'mamba', 'virtualenv', 'pyenv', 'rbenv', 'rvm', 'nvm', 'fnm', 'volta', 'asdf', 'sdkman', 'jenv', 'gvm', 'rustup', 'cargo', 'stack', 'ghc', 'cabal', 'opam', 'esy', 'dune', 'mix', 'hex', 'rebar', 'erlang.mk'].includes(ext)) return 'code';
  if (['txt', 'md'].includes(ext)) return 'text';
  return 'unknown';
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function CodePreview({ content, filename }: { content: string; filename: string }) {
  return (
    <div className="attachment-preview-code-wrapper">
      <div className="attachment-preview-code-header">
        <span className="attachment-preview-code-filename">{filename}</span>
      </div>
      <pre className="attachment-preview-code-content">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function TextPreview({ content, filename }: { content: string; filename?: string }) {
  return (
    <div className="attachment-preview-text-wrapper">
      {filename && (
        <div className="attachment-preview-text-header">
          <span className="attachment-preview-text-filename">{filename}</span>
        </div>
      )}
      <pre className="attachment-preview-text-content">{content}</pre>
    </div>
  );
}

function PdfPreview({ attachment }: { attachment: FileAttachment }) {
  const handleOpenInBrowser = () => {
    if (attachment.path && window.electronAPI?.shell?.openPath) {
      window.electronAPI.shell.openPath(attachment.path);
    } else if (attachment.url) {
      window.open(attachment.url, '_blank');
    }
  };

  return (
    <div className="attachment-preview-pdf-wrapper">
      <div className="attachment-preview-pdf-header">
        <button
          type="button"
          onClick={handleOpenInBrowser}
          className="attachment-preview-pdf-open-btn"
          title="Open in browser"
        >
          <DownloadIcon size={14} />
          <span>Open</span>
        </button>
      </div>
      <div className="attachment-preview-pdf-content">
        {attachment.thumbnail ? (
          <img
            src={attachment.thumbnail}
            alt={attachment.name}
            className="attachment-preview-pdf-thumbnail"
          />
        ) : (
          <div className="attachment-preview-pdf-placeholder">
            <FileTextIcon size={48} />
            <span>PDF Document</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DocPreview({ attachment }: { attachment: FileAttachment }) {
  return (
    <div className="attachment-preview-doc-wrapper">
      <div className="attachment-preview-doc-header">
        <span className="attachment-preview-doc-filename">{attachment.name}</span>
      </div>
      <div className="attachment-preview-doc-content">
        {attachment.text ? (
          <pre className="attachment-preview-doc-text">{attachment.text}</pre>
        ) : attachment.thumbnail ? (
          <img
            src={attachment.thumbnail}
            alt={attachment.name}
            className="attachment-preview-doc-thumbnail"
          />
        ) : (
          <div className="attachment-preview-doc-placeholder">
            <FileTextIcon size={48} />
            <span>Word Document</span>
            <span className="attachment-preview-doc-hint">
              {attachment.path ? 'Document parsed content will appear here' : 'No preview available'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ImagePreview({ attachment }: { attachment: FileAttachment }) {
  const src = attachment.displayUrl || attachment.url;
  return (
    <div className="attachment-preview-image-wrapper">
      <img
        src={src}
        alt={attachment.name}
        className="attachment-preview-image-img"
      />
    </div>
  );
}

export function AttachmentPreviewModal({ attachment, pastedContent, onClose }: AttachmentPreviewModalProps) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const previewType = useMemo(() => {
    if (pastedContent) return 'text';
    if (!attachment) return 'unknown';
    return getPreviewType(attachment);
  }, [attachment, pastedContent]);

  const title = useMemo(() => {
    if (pastedContent) return 'Pasted Content';
    return attachment?.name || 'Preview';
  }, [attachment, pastedContent]);

  const subtitle = useMemo(() => {
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
  }, [attachment, pastedContent]);

  if (!attachment && !pastedContent) return null;

  return (
    <div
      className="attachment-preview-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${title}`}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="attachment-preview-close"
        aria-label="Close preview"
      >
        <XIcon size={20} />
      </button>

      {/* Modal container */}
      <div
        className="attachment-preview-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="attachment-preview-header">
          <div className="attachment-preview-title-group">
            <h3 className="attachment-preview-title">{title}</h3>
            {subtitle && (
              <span className="attachment-preview-subtitle">{subtitle}</span>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="attachment-preview-body">
          {previewType === 'image' && attachment && (
            <ImagePreview attachment={attachment} />
          )}
          {previewType === 'pdf' && attachment && (
            <PdfPreview attachment={attachment} />
          )}
          {previewType === 'doc' && attachment && (
            <DocPreview attachment={attachment} />
          )}
          {previewType === 'code' && attachment && (
            <CodePreview
              content={attachment.text || 'No content available'}
              filename={attachment.name}
            />
          )}
          {previewType === 'text' && (
            <TextPreview
              content={pastedContent?.content || attachment?.text || attachment?.name || ''}
              filename={pastedContent ? undefined : attachment?.name}
            />
          )}
          {previewType === 'unknown' && attachment && (
            <div className="attachment-preview-unknown">
              <FileTextIcon size={48} />
              <span>No preview available for this file type</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
