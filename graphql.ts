// GraphQL: the /api/graphql surface — the documents gh and github-mcp-server
// send (repository, viewer, issues, pull requests, search, node, the five
// mutations, and introspection). A small recursive-descent parser for the
// GraphQL query language, then resolvers over the same store the REST and git
// surfaces use. Unknown fields answer HTTP 200 with an errors array naming
// them (per the spec); an unknown repository answers data.repository = null
// with no errors; unauthenticated requests are 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  diffFiles,
  nowIso,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { computeMergeable, filesAtTip, squashMerge } from './rest.ts';
import { isAuthorized, parseJsonBody, readBody, sendJson, type ForgeContext } from './http.ts';

// ---------------------------------------------------------------------------
// Query language parser (subset: operations, fragments, variables, arguments)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: FieldNode[] | null;
}

interface VariableDef {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: VariableDef[];
  selections: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FieldNode[]>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token['kind'], value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1];
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === '"') value += '"';
          else if (escaped === '\\') value += '\\';
          else if (escaped === '/') value += '/';
          else if (escaped === 'b') value += '\b';
          else if (escaped === 'f') value += '\f';
          else if (escaped === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      push('string', value);
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      push(isFloat ? 'float' : 'int', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      push('name', source.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push('punct', '...');
      i += 3;
      continue;
    }
    if ('{}()[]:!@$=&|'.includes(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    throw new Error(`GraphQL parse error: unexpected character ${JSON.stringify(ch)}`);
  }
  push('eof', '');
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`GraphQL parse error: expected ${value}, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`GraphQL parse error: expected name ${value ?? ''}, got ${token.value}`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FieldNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          type: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword, name, variables, selections: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName('on');
        this.expectName(); // the type condition
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`GraphQL parse error: unexpected ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDef[] {
    const defs: VariableDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseTypeName();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, type, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseTypeName(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseTypeName()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    // Fragment spread or inline fragment.
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        this.expectName();
        this.skipDirectives();
        return { alias: null, name: '__inline', args: [], selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { alias: null, name: `__fragment:${name}`, args: [], selections: null };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: FieldNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'Int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'Float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`GraphQL parse error: unexpected value ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((value) => resolveValue(value, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, and decodable (base64 of "<Type>:<key>").
// ---------------------------------------------------------------------------

function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (decoded.startsWith('cursor:')) {
      const n = parseInt(decoded.slice('cursor:'.length), 10);
      return Number.isFinite(n) ? n + 1 : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Introspection schema table
// ---------------------------------------------------------------------------

interface SchemaField {
  name: string;
  type: string;
  args?: { name: string; type: string }[];
}

interface SchemaType {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT' | 'INTERFACE' | 'UNION';
  fields?: SchemaField[];
  enumValues?: string[];
  inputFields?: { name: string; type: string }[];
  description?: string;
}

const SCHEMA: Record<string, SchemaType> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User!' },
      { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
      { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
      { name: 'search', type: 'SearchResultItemConnection!', args: [{ name: 'type', type: 'SearchType!' }, { name: 'query', type: 'String!' }, { name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
      { name: '__schema', type: '__Schema!' },
      { name: '__type', type: '__Type', args: [{ name: 'name', type: 'String!' }] },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
      { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
      { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String!' },
      { name: 'nameWithOwner', type: 'String!' },
      { name: 'owner', type: 'RepositoryOwner!' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean!' },
      { name: 'url', type: 'URI!' },
      { name: 'description', type: 'String' },
      { name: 'createdAt', type: 'DateTime!' },
      { name: 'updatedAt', type: 'DateTime!' },
      { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
      { name: 'issues', type: 'IssueConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'states', type: '[IssueState!]' }, { name: 'orderBy', type: 'IssueOrder' }] },
      { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
      { name: 'pullRequests', type: 'PullRequestConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'states', type: '[PullRequestState!]' }, { name: 'orderBy', type: 'PullRequestOrder' }] },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String!' },
      { name: 'state', type: 'IssueState!' },
      { name: 'createdAt', type: 'DateTime!' },
      { name: 'updatedAt', type: 'DateTime!' },
      { name: 'closedAt', type: 'DateTime' },
      { name: 'author', type: 'User' },
      { name: 'repository', type: 'Repository!' },
      { name: 'url', type: 'URI!' },
      { name: 'comments', type: 'IssueCommentConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
      { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String!' },
      { name: 'state', type: 'PullRequestState!' },
      { name: 'merged', type: 'Boolean!' },
      { name: 'mergeable', type: 'MergeableState!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefOid', type: 'String' },
      { name: 'baseRefOid', type: 'String' },
      { name: 'createdAt', type: 'DateTime!' },
      { name: 'updatedAt', type: 'DateTime!' },
      { name: 'closedAt', type: 'DateTime' },
      { name: 'mergedAt', type: 'DateTime' },
      { name: 'author', type: 'User' },
      { name: 'repository', type: 'Repository!' },
      { name: 'url', type: 'URI!' },
      { name: 'files', type: 'PullRequestChangedFileConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
      { name: 'comments', type: 'IssueCommentConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'login', type: 'String!' },
      { name: 'name', type: 'String' },
      { name: 'avatarUrl', type: 'URI!' },
      { name: 'url', type: 'URI!' },
      { name: 'repositories', type: 'RepositoryConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
      { name: 'repository', type: 'Repository', args: [{ name: 'name', type: 'String!' }] },
    ],
  },
  RepositoryOwner: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'login', type: 'String!' },
      { name: 'avatarUrl', type: 'URI!' },
      { name: 'url', type: 'URI!' },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'prefix', type: 'String!' },
      { name: 'target', type: 'GitObject' },
    ],
  },
  GitObject: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'oid', type: 'String!' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'nodes', type: '[Issue]' },
      { name: 'edges', type: '[IssueEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Issue' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'nodes', type: '[PullRequest]' },
      { name: 'edges', type: '[PullRequestEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequest' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  RepositoryConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'nodes', type: '[Repository]' },
      { name: 'edges', type: '[RepositoryEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  RepositoryEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Repository' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'nodes', type: '[IssueComment]' },
      { name: 'edges', type: '[IssueCommentEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'IssueComment' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'databaseId', type: 'Int' },
      { name: 'body', type: 'String!' },
      { name: 'author', type: 'User' },
      { name: 'createdAt', type: 'DateTime!' },
      { name: 'updatedAt', type: 'DateTime!' },
      { name: 'url', type: 'URI!' },
    ],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'nodes', type: '[Label]' },
      { name: 'edges', type: '[LabelEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  LabelEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'Label' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  Label: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'name', type: 'String!' },
      { name: 'color', type: 'String!' },
      { name: 'description', type: 'String' },
    ],
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'issueCount', type: 'Int!' },
      { name: 'repositoryCount', type: 'Int!' },
      { name: 'userCount', type: 'Int!' },
      { name: 'nodes', type: '[SearchResultItem]' },
      { name: 'edges', type: '[SearchResultItemEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  SearchResultItemEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'SearchResultItem' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'totalCount', type: 'Int!' },
      { name: 'nodes', type: '[PullRequestChangedFile]' },
      { name: 'edges', type: '[PullRequestChangedFileEdge]' },
      { name: 'pageInfo', type: 'PageInfo!' },
    ],
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'PullRequestChangedFile' },
      { name: 'cursor', type: 'String!' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String!' },
      { name: 'additions', type: 'Int!' },
      { name: 'deletions', type: 'Int!' },
      { name: 'changeType', type: 'String!' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean!' },
      { name: 'hasPreviousPage', type: 'Boolean!' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'issue', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'issue', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'commentEdge', type: 'IssueCommentEdge' },
      { name: 'subject', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'issueId', type: 'ID!' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID!' },
      { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID!' },
      { name: 'body', type: 'String!' },
      { name: 'clientMutationId', type: 'String' },
    ],
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  PullRequestOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'PullRequestOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  Node: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] },
  SearchResultItem: { kind: 'UNION' },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      { name: 'queryType', type: '__Type!' },
      { name: 'mutationType', type: '__Type' },
      { name: 'types', type: '[__Type!]!' },
      { name: 'directives', type: '[__Directive!]!' },
    ],
  },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'kind', type: '__TypeKind!' },
      { name: 'description', type: 'String' },
      { name: 'fields', type: '[__Field!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
      { name: 'enumValues', type: '[__EnumValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
      { name: 'inputFields', type: '[__InputValue!]' },
      { name: 'interfaces', type: '[__Type!]' },
      { name: 'possibleTypes', type: '[__Type!]' },
      { name: 'ofType', type: '__Type' },
    ],
  },
  __Field: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'args', type: '[__InputValue!]!' },
      { name: 'type', type: '__Type!' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'type', type: '__Type!' },
      { name: 'defaultValue', type: 'String' },
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'isDeprecated', type: 'Boolean!' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __Directive: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String!' },
      { name: 'description', type: 'String' },
      { name: 'locations', type: '[__DirectiveLocation!]!' },
      { name: 'args', type: '[__InputValue!]!' },
      { name: 'isRepeatable', type: 'Boolean!' },
    ],
  },
  __TypeKind: { kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __DirectiveLocation: { kind: 'ENUM', enumValues: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
};

// ---------------------------------------------------------------------------
// Node model and resolvers
// ---------------------------------------------------------------------------

type Comment = { id: number; body: string; createdAt: string };

type GqlNode =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pr: Pull }
  | { __typename: 'User'; login: string }
  | { __typename: 'RepositoryOwner'; login: string }
  | { __typename: 'Ref'; repo: Repo; name: string; oid: string }
  | { __typename: 'GitObject'; repo: Repo; oid: string; type: string }
  | { __typename: 'IssueConnection'; repo: Repo; all: Issue[]; page: Issue[]; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'IssueEdge'; node: GqlNode; cursor: string }
  | { __typename: 'PullRequestConnection'; repo: Repo; all: Pull[]; page: Pull[]; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'PullRequestEdge'; node: GqlNode; cursor: string }
  | { __typename: 'RepositoryConnection'; all: Repo[]; page: Repo[]; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'RepositoryEdge'; node: GqlNode; cursor: string }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue; all: Comment[]; page: Comment[]; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'IssueCommentEdge'; node: GqlNode; cursor: string }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: Comment }
  | { __typename: 'LabelConnection'; repo: Repo; labels: { id: number; name: string; color: string }[] }
  | { __typename: 'LabelEdge'; node: GqlNode; cursor: string }
  | { __typename: 'Label'; repo: Repo; label: { id: number; name: string; color: string } }
  | { __typename: 'SearchResultItemConnection'; all: GqlNode[]; page: GqlNode[]; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null; issueCount: number; repositoryCount: number; userCount: number }
  | { __typename: 'SearchResultItemEdge'; node: GqlNode; cursor: string }
  | { __typename: 'PullRequestChangedFileConnection'; repo: Repo; pr: Pull; files: { path: string; additions: number; deletions: number; changeType: string }[] }
  | { __typename: 'PullRequestChangedFileEdge'; node: GqlNode; cursor: string }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'CreateIssuePayload'; issue: GqlNode | null; clientMutationId: string | null }
  | { __typename: 'CloseIssuePayload'; issue: GqlNode | null; clientMutationId: string | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: GqlNode | null; clientMutationId: string | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: GqlNode | null; clientMutationId: string | null }
  | { __typename: 'AddCommentPayload'; commentEdge: GqlNode | null; subject: GqlNode | null; clientMutationId: string | null }
  | { __typename: '__Type'; name: string | null; kind: string; ofType: GqlNode | null; namedType: string | null }
  | { __typename: '__Schema' }
  | { __typename: '__Field'; name: string; type: string; args: { name: string; type: string }[] }
  | { __typename: '__InputValue'; name: string; type: string; defaultValue: string | null }
  | { __typename: '__EnumValue'; name: string };

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FieldNode[]>;
  errors: { message: string }[];
}

function pageOf<T>(all: T[], args: Record<string, unknown>): { page: T[]; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } {
  const start = decodeCursor(args.after as string | null | undefined);
  const first = typeof args.first === 'number' ? args.first : all.length;
  const page = all.slice(start, start + first);
  const hasNextPage = start + first < all.length;
  const hasPreviousPage = start > 0;
  return {
    page,
    hasNextPage,
    hasPreviousPage,
    startCursor: page.length > 0 ? encodeCursor(start) : null,
    endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = (orderBy as { field?: string; direction?: string } | null) ?? null;
  const field = order?.field ?? 'CREATED_AT';
  const direction = order?.direction ?? 'DESC';
  // createdAt is an ISO string; seq is the monotonic creation order, so
  // CREATED_AT order is seq order, and ties fall back to the number.
  const key = (issue: Issue): number | string =>
    field === 'UPDATED_AT' ? issue.updatedAt : field === 'COMMENTS' ? issue.comments.length : issue.seq;
  return [...issues].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const diff =
      typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
    const total = diff !== 0 ? diff : a.number - b.number;
    return direction === 'ASC' ? total : -total;
  });
}

function sortPullRequests(prs: Pull[], orderBy: unknown): Pull[] {
  const order = (orderBy as { field?: string; direction?: string } | null) ?? null;
  const field = order?.field ?? 'CREATED_AT';
  const direction = order?.direction ?? 'DESC';
  const key = (pr: Pull): number | string => (field === 'UPDATED_AT' ? pr.updatedAt : pr.seq);
  return [...prs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const diff =
      typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
    const total = diff !== 0 ? diff : a.number - b.number;
    return direction === 'ASC' ? total : -total;
  });
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = parseInt(decoded.key, 10);
  if (!Number.isFinite(repoId)) return null;
  return store.findRepoByDatabaseId(repoId) ?? null;
}

function nodeByGlobalId(store: Store, id: string): GqlNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = findRepoByGlobalId(store, id);
    return repo === null ? null : { __typename: 'Repository', repo };
  }
  if (decoded.kind === 'Issue') {
    const found = store.findIssueByGlobalId(id);
    return found === null ? null : { __typename: 'Issue', repo: found.repo, issue: found.issue };
  }
  if (decoded.kind === 'PullRequest') {
    const found = store.findPullByGlobalId(id);
    return found === null ? null : { __typename: 'PullRequest', repo: found.repo, pr: found.pull };
  }
  if (decoded.kind === 'User') {
    return { __typename: 'User', login: VIEWER_LOGIN };
  }
  return null;
}

function prState(pr: Pull): string {
  if (pr.state === 'open') return 'OPEN';
  if (pr.state === 'merged') return 'MERGED';
  return 'CLOSED';
}

function prMergeable(repo: Repo, pr: Pull): string {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  return computeMergeable(repo, headTip, baseTip) ? 'MERGEABLE' : 'CONFLICTING';
}

function typeRefNode(typeStr: string): GqlNode {
  if (typeStr.endsWith('!')) {
    return { __typename: '__Type', name: null, kind: 'NON_NULL', ofType: typeRefNode(typeStr.slice(0, -1)), namedType: null };
  }
  if (typeStr.startsWith('[') && typeStr.endsWith(']')) {
    return { __typename: '__Type', name: null, kind: 'LIST', ofType: typeRefNode(typeStr.slice(1, -1)), namedType: null };
  }
  const base = SCHEMA[typeStr];
  return { __typename: '__Type', name: typeStr, kind: base?.kind ?? 'OBJECT', ofType: null, namedType: typeStr };
}

function typeNodeFor(name: string): GqlNode {
  const entry = SCHEMA[name];
  return { __typename: '__Type', name, kind: entry?.kind ?? 'OBJECT', ofType: null, namedType: name };
}

function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = new Set(oldText.split('\n'));
  const newLines = new Set(newText.split('\n'));
  let additions = 0;
  let deletions = 0;
  for (const line of newLines) if (!oldLines.has(line)) additions += 1;
  for (const line of oldLines) if (!newLines.has(line)) deletions += 1;
  return { additions, deletions };
}

type Resolver = (node: never, args: Record<string, unknown>, ctx: ExecContext) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER_LOGIN }) as GqlNode,
    repository: (_node, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlNode);
    },
    node: (_node, args, ctx) => nodeByGlobalId(ctx.store, String(args.id ?? '')),
    search: (_node, args, ctx) => {
      const type = String(args.type ?? '');
      const queryText = String(args.query ?? '').toLowerCase();
      const nodes: GqlNode[] = [];
      let issueCount = 0;
      let repositoryCount = 0;
      let userCount = 0;
      if (type === 'ISSUE') {
        for (const repo of ctx.store.listViewerRepos()) {
          for (const issue of repo.issues) {
            if (issue.title.toLowerCase().includes(queryText) || issue.body.toLowerCase().includes(queryText)) {
              nodes.push({ __typename: 'Issue', repo, issue });
            }
          }
        }
        issueCount = nodes.length;
      } else if (type === 'REPOSITORY') {
        for (const repo of ctx.store.listViewerRepos()) {
          if (repo.name.toLowerCase().includes(queryText) || (repo.description ?? '').toLowerCase().includes(queryText)) {
            nodes.push({ __typename: 'Repository', repo });
          }
        }
        repositoryCount = nodes.length;
      } else if (type === 'PULL_REQUEST') {
        for (const repo of ctx.store.listViewerRepos()) {
          for (const pr of repo.pulls) {
            if (pr.title.toLowerCase().includes(queryText) || pr.body.toLowerCase().includes(queryText)) {
              nodes.push({ __typename: 'PullRequest', repo, pr });
            }
          }
        }
      } else if (type === 'USER') {
        if (queryText === '' || VIEWER_LOGIN.toLowerCase().includes(queryText)) {
          nodes.push({ __typename: 'User', login: VIEWER_LOGIN });
          userCount = 1;
        }
      }
      const page = pageOf(nodes, args);
      return {
        __typename: 'SearchResultItemConnection',
        all: nodes,
        page: page.page,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
        issueCount,
        repositoryCount,
        userCount,
      } as GqlNode;
    },
    __schema: () => ({ __typename: '__Schema' }) as GqlNode,
    __type: (_node, args) => {
      const name = String(args.name ?? '');
      return SCHEMA[name] === undefined ? null : typeNodeFor(name);
    },
  },
  Mutation: {
    createIssue: (_node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : null;
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return { __typename: 'CreateIssuePayload', issue: null, clientMutationId } as GqlNode;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const issue = ctx.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } as GqlNode, clientMutationId } as GqlNode;
    },
    closeIssue: (_node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      const found = typeof input.issueId === 'string' ? ctx.store.findIssueByGlobalId(input.issueId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return { __typename: 'CloseIssuePayload', issue: null, clientMutationId } as GqlNode;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = nowIso();
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } as GqlNode, clientMutationId } as GqlNode;
    },
    createPullRequest: (_node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : null;
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId } as GqlNode;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (head === base) {
        ctx.errors.push({ message: 'head or base branch does not exist' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId } as GqlNode;
      }
      const created = ctx.store.createPull(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', head, base);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId } as GqlNode;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pr: created } as GqlNode, clientMutationId } as GqlNode;
    },
    mergePullRequest: (_node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      const found = typeof input.pullRequestId === 'string' ? ctx.store.findPullByGlobalId(input.pullRequestId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId } as GqlNode;
      }
      const { repo, pull: pr } = found;
      if (pr.state !== 'open') {
        ctx.errors.push({ message: 'Pull request has already been merged' });
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pr } as GqlNode, clientMutationId } as GqlNode;
      }
      const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (headTip === undefined || baseTip === undefined) {
        ctx.errors.push({ message: 'head or base branch does not exist' });
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pr } as GqlNode, clientMutationId } as GqlNode;
      }
      const merge = squashMerge(repo, headTip, baseTip, pr.baseRef);
      if (merge === null) {
        ctx.errors.push({ message: 'Merge conflict' });
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pr } as GqlNode, clientMutationId } as GqlNode;
      }
      pr.state = 'merged';
      pr.merged = true;
      pr.mergeSha = merge.commitOid;
      pr.mergedAt = nowIso();
      pr.updatedAt = nowIso();
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pr } as GqlNode, clientMutationId } as GqlNode;
    },
    addComment: (_node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      const found = typeof input.subjectId === 'string' ? ctx.store.findIssueByGlobalId(input.subjectId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return { __typename: 'AddCommentPayload', commentEdge: null, subject: null, clientMutationId } as GqlNode;
      }
      const comment: Comment = {
        id: found.repo.nextCommentId++,
        body: typeof input.body === 'string' ? input.body : '',
        createdAt: nowIso(),
      };
      found.issue.comments.push(comment);
      found.issue.updatedAt = nowIso();
      const commentNode = { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment } as GqlNode;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentNode, cursor: encodeCursor(found.issue.comments.length - 1) } as GqlNode,
        subject: { __typename: 'Issue', repo: found.repo, issue: found.issue } as GqlNode,
        clientMutationId,
      } as GqlNode;
    },
  },
  Repository: {
    id: (node) => encodeGlobalId('Repository', String((node as { repo: Repo }).repo.databaseId)),
    databaseId: (node) => (node as { repo: Repo }).repo.databaseId,
    name: (node) => (node as { repo: Repo }).repo.name,
    nameWithOwner: (node) => `${VIEWER_LOGIN}/${(node as { repo: Repo }).repo.name}`,
    owner: () => ({ __typename: 'RepositoryOwner', login: VIEWER_LOGIN }) as GqlNode,
    defaultBranchRef: (node) => {
      const repo = (node as { repo: Repo }).repo;
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      // GitHub's Ref.name is the short branch name ("main"), not the full
      // ref; fullName is kept so the prefix resolver still sees refs/heads/.
      return oid === undefined ? null : ({ __typename: 'Ref', repo, name: repo.defaultBranch, fullName: `refs/heads/${repo.defaultBranch}`, oid } as GqlNode);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (node) => `https://github.com/${VIEWER_LOGIN}/${(node as { repo: Repo }).repo.name}`,
    description: (node) => (node as { repo: Repo }).repo.description,
    createdAt: (node) => (node as { repo: Repo }).repo.createdAt,
    updatedAt: (node) => (node as { repo: Repo }).repo.updatedAt,
    issue: (node, args) => {
      const repo = (node as { repo: Repo }).repo;
      const issue = repo.issues.find((i) => i.number === (args.number as number));
      return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlNode);
    },
    issues: (node, args) => {
      const repo = (node as { repo: Repo }).repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let issues = repo.issues.filter((issue) => states === null || states.includes(issue.state.toUpperCase()));
      issues = sortIssues(issues, args.orderBy);
      const page = pageOf(issues, args);
      return {
        __typename: 'IssueConnection',
        repo,
        all: issues,
        page: page.page,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
      } as GqlNode;
    },
    pullRequest: (node, args) => {
      const repo = (node as { repo: Repo }).repo;
      const pr = repo.pulls.find((p) => p.number === (args.number as number));
      return pr === undefined ? null : ({ __typename: 'PullRequest', repo, pr } as GqlNode);
    },
    pullRequests: (node, args) => {
      const repo = (node as { repo: Repo }).repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let prs = repo.pulls.filter((pr) => states === null || states.includes(prState(pr)));
      prs = sortPullRequests(prs, args.orderBy);
      const page = pageOf(prs, args);
      return {
        __typename: 'PullRequestConnection',
        repo,
        all: prs,
        page: page.page,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
      } as GqlNode;
    },
  },
  Issue: {
    id: (node) => {
      const n = node as { repo: Repo; issue: Issue };
      return encodeGlobalId('Issue', `${n.repo.databaseId}:${n.issue.number}`);
    },
    databaseId: (node) => (node as { issue: Issue }).issue.id,
    number: (node) => (node as { issue: Issue }).issue.number,
    title: (node) => (node as { issue: Issue }).issue.title,
    body: (node) => (node as { issue: Issue }).issue.body,
    state: (node) => (node as { issue: Issue }).issue.state.toUpperCase(),
    createdAt: (node) => (node as { issue: Issue }).issue.createdAt,
    updatedAt: (node) => (node as { issue: Issue }).issue.updatedAt,
    closedAt: (node) => {
      const issue = (node as { issue: Issue }).issue;
      return issue.state === 'closed' ? issue.updatedAt : null;
    },
    author: () => ({ __typename: 'User', login: VIEWER_LOGIN }) as GqlNode,
    repository: (node) => ({ __typename: 'Repository', repo: (node as { repo: Repo }).repo }) as GqlNode,
    url: (node) => {
      const n = node as { repo: Repo; issue: Issue };
      return `https://github.com/${VIEWER_LOGIN}/${n.repo.name}/issues/${n.issue.number}`;
    },
    comments: (node, args) => {
      const n = node as { repo: Repo; issue: Issue };
      const page = pageOf(n.issue.comments, args);
      return {
        __typename: 'IssueCommentConnection',
        repo: n.repo,
        issue: n.issue,
        all: n.issue.comments,
        page: page.page,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
      } as GqlNode;
    },
    labels: (node, args) => {
      const n = node as { repo: Repo; issue: Issue };
      const page = pageOf(n.issue.labels, args);
      return {
        __typename: 'LabelConnection',
        repo: n.repo,
        labels: page.page,
      } as GqlNode;
    },
  },
  PullRequest: {
    id: (node) => {
      const n = node as { repo: Repo; pr: Pull };
      return encodeGlobalId('PullRequest', `${n.repo.databaseId}:${n.pr.number}`);
    },
    databaseId: (node) => (node as { pr: Pull }).pr.id,
    number: (node) => (node as { pr: Pull }).pr.number,
    title: (node) => (node as { pr: Pull }).pr.title,
    body: (node) => (node as { pr: Pull }).pr.body,
    state: (node) => prState((node as { pr: Pull }).pr),
    merged: (node) => (node as { pr: Pull }).pr.merged,
    mergeable: (node) => {
      const n = node as { repo: Repo; pr: Pull };
      return prMergeable(n.repo, n.pr);
    },
    headRefName: (node) => (node as { pr: Pull }).pr.headRef,
    baseRefName: (node) => (node as { pr: Pull }).pr.baseRef,
    headRefOid: (node) => {
      const n = node as { repo: Repo; pr: Pull };
      return n.repo.refs.get(`refs/heads/${n.pr.headRef}`) ?? null;
    },
    baseRefOid: (node) => {
      const n = node as { repo: Repo; pr: Pull };
      return n.repo.refs.get(`refs/heads/${n.pr.baseRef}`) ?? null;
    },
    createdAt: (node) => (node as { pr: Pull }).pr.createdAt,
    updatedAt: (node) => (node as { pr: Pull }).pr.updatedAt,
    closedAt: (node) => {
      const pr = (node as { pr: Pull }).pr;
      return pr.state === 'open' ? null : pr.updatedAt;
    },
    mergedAt: (node) => (node as { pr: Pull }).pr.mergedAt,
    author: () => ({ __typename: 'User', login: VIEWER_LOGIN }) as GqlNode,
    repository: (node) => ({ __typename: 'Repository', repo: (node as { repo: Repo }).repo }) as GqlNode,
    url: (node) => {
      const n = node as { repo: Repo; pr: Pull };
      return `https://github.com/${VIEWER_LOGIN}/${n.repo.name}/pull/${n.pr.number}`;
    },
    files: (node, args) => {
      const n = node as { repo: Repo; pr: Pull };
      const files = changedFilesOf(n.repo, n.pr);
      const page = pageOf(files, args);
      return {
        __typename: 'PullRequestChangedFileConnection',
        repo: n.repo,
        pr: n.pr,
        files: page.page,
      } as GqlNode;
    },
    comments: (node, args) => {
      const n = node as { repo: Repo; pr: Pull };
      const page = pageOf([], args);
      return {
        __typename: 'IssueCommentConnection',
        repo: n.repo,
        issue: { id: n.pr.id, number: n.pr.number, title: n.pr.title, body: n.pr.body, state: 'open', labels: [], comments: [], createdAt: n.pr.createdAt, updatedAt: n.pr.updatedAt, seq: n.pr.seq },
        all: [],
        page: page.page,
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      } as GqlNode;
    },
  },
  User: {
    id: () => encodeGlobalId('User', '1000'),
    databaseId: () => 1000,
    login: () => VIEWER_LOGIN,
    name: () => 'Ada Iversen',
    avatarUrl: () => 'https://avatars.githubusercontent.com/u/1000?v=4',
    url: () => `https://github.com/${VIEWER_LOGIN}`,
    repositories: (_node, args, ctx) => {
      const all = ctx.store.listViewerRepos();
      const page = pageOf(all, args);
      return {
        __typename: 'RepositoryConnection',
        all,
        page: page.page,
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
      } as GqlNode;
    },
    repository: (_node, args, ctx) => {
      const repo = ctx.store.getRepo(VIEWER_LOGIN, String(args.name ?? ''));
      return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlNode);
    },
  },
  RepositoryOwner: {
    id: () => encodeGlobalId('User', '1000'),
    login: () => VIEWER_LOGIN,
    avatarUrl: () => 'https://avatars.githubusercontent.com/u/1000?v=4',
    url: () => `https://github.com/${VIEWER_LOGIN}`,
  },
  Ref: {
    name: (node) => (node as { name: string }).name,
    prefix: (node) => {
      const name = (node as { name: string; fullName?: string }).fullName ?? (node as { name: string }).name;
      return name.startsWith('refs/heads/') ? 'refs/heads/' : name.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/';
    },
    target: (node) => {
      const n = node as { repo: Repo; oid: string };
      const obj = n.repo.objects.get(n.oid);
      return obj === undefined ? null : ({ __typename: 'GitObject', repo: n.repo, oid: n.oid, type: obj.type } as GqlNode);
    },
  },
  GitObject: {
    id: (node) => encodeGlobalId('GitObject', (node as { oid: string }).oid),
    oid: (node) => (node as { oid: string }).oid,
  },
  IssueConnection: {
    totalCount: (node) => (node as { all: unknown[] }).all.length,
    nodes: (node) => (node as { page: Issue[]; repo: Repo }).page.map((issue) => ({ __typename: 'Issue', repo: (node as { repo: Repo }).repo, issue }) as GqlNode),
    edges: (node) => {
      const n = node as { page: Issue[]; repo: Repo; all: Issue[] };
      return n.page.map((issue) => {
        const index = n.all.indexOf(issue);
        return { __typename: 'IssueEdge', node: { __typename: 'Issue', repo: n.repo, issue } as GqlNode, cursor: encodeCursor(index) } as GqlNode;
      });
    },
    pageInfo: (node) => {
      const n = node as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return { __typename: 'PageInfo', hasNextPage: n.hasNextPage, hasPreviousPage: n.hasPreviousPage, startCursor: n.startCursor, endCursor: n.endCursor } as GqlNode;
    },
  },
  IssueEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  PullRequestConnection: {
    totalCount: (node) => (node as { all: unknown[] }).all.length,
    nodes: (node) => (node as { page: Pull[]; repo: Repo }).page.map((pr) => ({ __typename: 'PullRequest', repo: (node as { repo: Repo }).repo, pr }) as GqlNode),
    edges: (node) => {
      const n = node as { page: Pull[]; repo: Repo; all: Pull[] };
      return n.page.map((pr) => {
        const index = n.all.indexOf(pr);
        return { __typename: 'PullRequestEdge', node: { __typename: 'PullRequest', repo: n.repo, pr } as GqlNode, cursor: encodeCursor(index) } as GqlNode;
      });
    },
    pageInfo: (node) => {
      const n = node as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return { __typename: 'PageInfo', hasNextPage: n.hasNextPage, hasPreviousPage: n.hasPreviousPage, startCursor: n.startCursor, endCursor: n.endCursor } as GqlNode;
    },
  },
  PullRequestEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  RepositoryConnection: {
    totalCount: (node) => (node as { all: unknown[] }).all.length,
    nodes: (node) => (node as { page: Repo[] }).page.map((repo) => ({ __typename: 'Repository', repo }) as GqlNode),
    edges: (node) => {
      const n = node as { page: Repo[]; all: Repo[] };
      return n.page.map((repo) => {
        const index = n.all.indexOf(repo);
        return { __typename: 'RepositoryEdge', node: { __typename: 'Repository', repo } as GqlNode, cursor: encodeCursor(index) } as GqlNode;
      });
    },
    pageInfo: (node) => {
      const n = node as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return { __typename: 'PageInfo', hasNextPage: n.hasNextPage, hasPreviousPage: n.hasPreviousPage, startCursor: n.startCursor, endCursor: n.endCursor } as GqlNode;
    },
  },
  RepositoryEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  IssueCommentConnection: {
    totalCount: (node) => (node as { all: unknown[] }).all.length,
    nodes: (node) => (node as { page: Comment[]; repo: Repo; issue: Issue }).page.map((comment) => ({ __typename: 'IssueComment', repo: (node as { repo: Repo }).repo, issue: (node as { issue: Issue }).issue, comment }) as GqlNode),
    edges: (node) => {
      const n = node as { page: Comment[]; repo: Repo; issue: Issue; all: Comment[] };
      return n.page.map((comment) => {
        const index = n.all.indexOf(comment);
        return { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo: n.repo, issue: n.issue, comment } as GqlNode, cursor: encodeCursor(index) } as GqlNode;
      });
    },
    pageInfo: (node) => {
      const n = node as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return { __typename: 'PageInfo', hasNextPage: n.hasNextPage, hasPreviousPage: n.hasPreviousPage, startCursor: n.startCursor, endCursor: n.endCursor } as GqlNode;
    },
  },
  IssueCommentEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  IssueComment: {
    id: (node) => {
      const n = node as { repo: Repo; issue: Issue; comment: Comment };
      return encodeGlobalId('IssueComment', `${n.repo.databaseId}:${n.issue.number}:${n.comment.id}`);
    },
    databaseId: (node) => (node as { comment: Comment }).comment.id,
    body: (node) => (node as { comment: Comment }).comment.body,
    author: () => ({ __typename: 'User', login: VIEWER_LOGIN }) as GqlNode,
    createdAt: (node) => (node as { comment: Comment }).comment.createdAt,
    updatedAt: (node) => (node as { comment: Comment }).comment.createdAt,
    url: (node) => {
      const n = node as { repo: Repo; issue: Issue; comment: Comment };
      return `https://github.com/${VIEWER_LOGIN}/${n.repo.name}/issues/${n.issue.number}#issuecomment-${n.comment.id}`;
    },
  },
  LabelConnection: {
    totalCount: (node) => (node as { labels: unknown[] }).labels.length,
    nodes: (node) => (node as { labels: { id: number; name: string; color: string }[]; repo: Repo }).labels.map((label) => ({ __typename: 'Label', repo: (node as { repo: Repo }).repo, label }) as GqlNode),
    edges: (node) => {
      const n = node as { labels: { id: number; name: string; color: string }[]; repo: Repo };
      return n.labels.map((label, index) => ({ __typename: 'LabelEdge', node: { __typename: 'Label', repo: n.repo, label } as GqlNode, cursor: encodeCursor(index) }) as GqlNode);
    },
    pageInfo: () => ({ __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as GqlNode,
  },
  LabelEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  Label: {
    id: (node) => {
      const n = node as { repo: Repo; label: { name: string } };
      return encodeGlobalId('Label', `${n.repo.databaseId}:${n.label.name}`);
    },
    name: (node) => (node as { label: { name: string } }).label.name,
    color: (node) => (node as { label: { color: string } }).label.color,
    description: () => '',
  },
  SearchResultItemConnection: {
    totalCount: (node) => (node as { all: unknown[] }).all.length,
    issueCount: (node) => (node as { issueCount: number }).issueCount,
    repositoryCount: (node) => (node as { repositoryCount: number }).repositoryCount,
    userCount: (node) => (node as { userCount: number }).userCount,
    nodes: (node) => (node as { page: GqlNode[] }).page,
    edges: (node) => {
      const n = node as { page: GqlNode[]; all: GqlNode[] };
      return n.page.map((item) => {
        const index = n.all.indexOf(item);
        return { __typename: 'SearchResultItemEdge', node: item, cursor: encodeCursor(index) } as GqlNode;
      });
    },
    pageInfo: (node) => {
      const n = node as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return { __typename: 'PageInfo', hasNextPage: n.hasNextPage, hasPreviousPage: n.hasPreviousPage, startCursor: n.startCursor, endCursor: n.endCursor } as GqlNode;
    },
  },
  SearchResultItemEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  PullRequestChangedFileConnection: {
    totalCount: (node) => (node as { files: unknown[] }).files.length,
    nodes: (node) => (node as { files: { path: string; additions: number; deletions: number; changeType: string }[] }).files.map((file) => ({ __typename: 'PullRequestChangedFile', ...file }) as GqlNode),
    edges: (node) => {
      const n = node as { files: { path: string; additions: number; deletions: number; changeType: string }[] };
      return n.files.map((file, index) => ({ __typename: 'PullRequestChangedFileEdge', node: { __typename: 'PullRequestChangedFile', ...file } as GqlNode, cursor: encodeCursor(index) }) as GqlNode);
    },
    pageInfo: () => ({ __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as GqlNode,
  },
  PullRequestChangedFileEdge: {
    node: (node) => (node as { node: GqlNode }).node,
    cursor: (node) => (node as { cursor: string }).cursor,
  },
  PullRequestChangedFile: {
    path: (node) => (node as { path: string }).path,
    additions: (node) => (node as { additions: number }).additions,
    deletions: (node) => (node as { deletions: number }).deletions,
    changeType: (node) => (node as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (node) => (node as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (node) => (node as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (node) => (node as { startCursor: string | null }).startCursor,
    endCursor: (node) => (node as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (node) => (node as { issue: GqlNode | null }).issue,
    clientMutationId: (node) => (node as { clientMutationId: string | null }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (node) => (node as { issue: GqlNode | null }).issue,
    clientMutationId: (node) => (node as { clientMutationId: string | null }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (node) => (node as { pullRequest: GqlNode | null }).pullRequest,
    clientMutationId: (node) => (node as { clientMutationId: string | null }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (node) => (node as { pullRequest: GqlNode | null }).pullRequest,
    clientMutationId: (node) => (node as { clientMutationId: string | null }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (node) => (node as { commentEdge: GqlNode | null }).commentEdge,
    subject: (node) => (node as { subject: GqlNode | null }).subject,
    clientMutationId: (node) => (node as { clientMutationId: string | null }).clientMutationId,
  },
  __Type: {
    name: (node) => (node as { name: string | null }).name,
    kind: (node) => (node as { kind: string }).kind,
    description: () => null,
    fields: (node) => {
      const n = node as { namedType: string | null };
      if (n.namedType === null) return null;
      const entry = SCHEMA[n.namedType];
      if (entry === undefined || entry.fields === undefined) return null;
      return entry.fields.map((field) => ({ __typename: '__Field', name: field.name, type: field.type, args: field.args ?? [] }) as GqlNode);
    },
    enumValues: (node) => {
      const n = node as { namedType: string | null };
      if (n.namedType === null) return null;
      const entry = SCHEMA[n.namedType];
      if (entry === undefined || entry.enumValues === undefined) return null;
      return entry.enumValues.map((value) => ({ __typename: '__EnumValue', name: value }) as GqlNode);
    },
    inputFields: (node) => {
      const n = node as { namedType: string | null };
      if (n.namedType === null) return null;
      const entry = SCHEMA[n.namedType];
      if (entry === undefined || entry.inputFields === undefined) return null;
      return entry.inputFields.map((field) => ({ __typename: '__InputValue', name: field.name, type: field.type, defaultValue: null }) as GqlNode);
    },
    interfaces: () => [],
    possibleTypes: () => [],
    ofType: (node) => (node as { ofType: GqlNode | null }).ofType,
  },
  __Schema: {
    queryType: () => typeNodeFor('Query'),
    mutationType: () => typeNodeFor('Mutation'),
    types: () => Object.keys(SCHEMA).map((name) => typeNodeFor(name)),
    directives: () => [],
  },
  __Field: {
    name: (node) => (node as { name: string }).name,
    description: () => null,
    args: (node) => (node as { args: { name: string; type: string }[] }).args.map((arg) => ({ __typename: '__InputValue', name: arg.name, type: arg.type, defaultValue: null }) as GqlNode),
    type: (node) => typeRefNode((node as { type: string }).type),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (node) => (node as { name: string }).name,
    description: () => null,
    type: (node) => typeRefNode((node as { type: string }).type),
    defaultValue: (node) => (node as { defaultValue: string | null }).defaultValue,
  },
  __EnumValue: {
    name: (node) => (node as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

/** The files changed between a pull request's base and head tips. */
function changedFilesOf(repo: Repo, pr: Pull): { path: string; additions: number; deletions: number; changeType: string }[] {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const baseFiles = filesAtTip(repo, baseTip);
  const headFiles = filesAtTip(repo, headTip);
  return diffFiles(baseFiles, headFiles).map((change) => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    changeType: change.status === 'added' ? 'ADDED' : change.status === 'modified' ? 'MODIFIED' : 'REMOVED',
  }));
}

function expandSelections(selections: FieldNode[], ctx: ExecContext, depth = 0): FieldNode[] {
  const out: FieldNode[] = [];
  for (const field of selections) {
    if (field.name === '__inline') {
      if (depth < 10) out.push(...expandSelections(field.selections ?? [], ctx, depth + 1));
    } else if (field.name.startsWith('__fragment:')) {
      const fragment = ctx.fragments.get(field.name.slice('__fragment:'.length));
      if (fragment !== undefined && depth < 10) out.push(...expandSelections(fragment, ctx, depth + 1));
    } else {
      out.push(field);
    }
  }
  return out;
}

function materialize(raw: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => materialize(item, field, ctx));
  if (typeof raw === 'object' && '__typename' in (raw as Record<string, unknown>)) {
    const node = raw as GqlNode;
    if (field.selections === null) return {};
    return executeSelections(node, field.selections, ctx);
  }
  return raw;
}

function resolveField(node: GqlNode, field: FieldNode, ctx: ExecContext): unknown {
  if (field.name === '__typename') return node.__typename;
  const table = RESOLVERS[node.__typename];
  const resolver = table?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${node.__typename}".` });
    return null;
  }
  const raw = resolver(node as never, argsMap(field, ctx.variables), ctx);
  return materialize(raw, field, ctx);
}

function executeSelections(node: GqlNode, selections: FieldNode[], ctx: ExecContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of expandSelections(selections, ctx)) {
    result[field.alias ?? field.name] = resolveField(node, field, ctx);
  }
  return result;
}

function executeGraphqlOperation(
  body: unknown,
  store: Store,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const op = (body ?? {}) as Record<string, unknown>;
  const query = typeof op.query === 'string' ? op.query : '';
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof op.operationName === 'string' ? op.operationName : null;
  try {
    const document = new Parser(tokenize(query)).parseDocument();
    const operation =
      operationName !== null
        ? (document.operations.find((o) => o.name === operationName) ?? document.operations[0])
        : document.operations[0];
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'No operation provided' }] };
    }
    const mergedVariables: Record<string, unknown> = {};
    for (const def of operation.variables) {
      if (def.defaultValue !== null) mergedVariables[def.name] = resolveValue(def.defaultValue, variables);
    }
    for (const [key, value] of Object.entries(variables)) mergedVariables[key] = value;
    const ctx: ExecContext = { store, variables: mergedVariables, fragments: document.fragments, errors: [] };
    const root: GqlNode = operation.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
    const data = executeSelections(root, operation.selections, ctx);
    return { data, errors: ctx.errors };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
}

/** Handle a GraphQL request. Returns true when the path was /api/graphql. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext): Promise<boolean> {
  if (req.url === undefined || !req.url.startsWith('/api/graphql')) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' }, ctx);
    return true;
  }
  if (!isAuthorized(req, ctx.token)) {
    sendJson(res, 401, { message: 'Requires authentication' }, ctx);
    return true;
  }
  const parsed = parseJsonBody(await readBody(req));
  if (!parsed.ok) {
    sendJson(res, 400, { message: parsed.error }, ctx);
    return true;
  }
  const body = parsed.value;
  const operations = Array.isArray(body) ? body : [body];
  const results = operations.map((operation) => executeGraphqlOperation(operation, ctx.store));
  sendJson(res, 200, Array.isArray(body) ? results : results[0], ctx);
  return true;
}
