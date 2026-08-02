import { createHash } from 'node:crypto';
import ts from 'typescript';

export interface MutationAstContext {
  symbol: string;
  normalized_call: string;
  scope_contract_sha256: string;
  code_offset: boolean;
}

interface AstSpan {
  start: number;
  end: number;
  symbol: string;
  scopeContractSha256: string;
}

interface AliasBinding {
  name: string;
  start: number;
  scope: ts.Node;
  kind: 'import' | 'declaration' | 'assignment';
  canonical?: string;
  expression?: ts.Expression;
  suffix?: string;
}

export interface MutationAstCall {
  node: ts.CallExpression;
  start: number;
  expressionEnd: number;
  end: number;
  line: number;
  symbol: string;
  written_callee: string | null;
  canonical_callee: string | null;
  normalized_call: string;
  scope_contract_sha256: string;
}

export interface MutationAstIndex {
  sourceFile: ts.SourceFile;
  scopes: AstSpan[];
  calls: MutationAstCall[];
}

export function buildMutationAstIndex(file: string, text: string): MutationAstIndex {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scopes: AstSpan[] = [];
  const callNodes: Array<{ node: ts.CallExpression; symbol: string; scope: ts.Node }> = [];
  const aliases = collectAliasBindings(sourceFile);
  const scopeDigests = new Map<ts.Node, string>();
  const scopeDigest = (node: ts.Node): string => {
    const cached = scopeDigests.get(node);
    if (cached) return cached;
    const digest = structuralScopeSha256(node, sourceFile);
    scopeDigests.set(node, digest);
    return digest;
  };

  const visit = (node: ts.Node, parentSymbol: string, parentScope: ts.Node): void => {
    let childParent = parentSymbol;
    let childScope = parentScope;
    const symbol = symbolForNode(node, parentSymbol, sourceFile);
    if (symbol) {
      const scopeContractSha256 = scopeDigest(node);
      scopes.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        symbol,
        scopeContractSha256
      });
      childParent = symbol;
      if (ts.isFunctionLike(node)) childScope = node;
    }
    if (ts.isCallExpression(node)) {
      callNodes.push({ node, symbol: childParent, scope: childScope });
    }
    ts.forEachChild(node, (child) => visit(child, childParent, childScope));
  };
  visit(sourceFile, 'module', sourceFile);

  const moduleContractSha256 = scopeDigest(sourceFile);
  const calls = callNodes.map(({ node, symbol, scope }) => ({
    node,
    start: node.expression.getStart(sourceFile),
    expressionEnd: node.expression.getEnd(),
    end: node.getEnd(),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    symbol,
    written_callee: writtenExpressionPath(node.expression),
    canonical_callee: resolveCanonicalExpression(node.expression, node, aliases, sourceFile, new Set()),
    normalized_call: normalizeMutationCall(node.getText(sourceFile)),
    scope_contract_sha256: scope === sourceFile
      ? moduleContractSha256
      : scopeDigest(scope)
  }));
  return { sourceFile, scopes, calls };
}

export function mutationAstContextAt(index: MutationAstIndex, offset: number, fallback: string): MutationAstContext {
  const scope = index.scopes
    .filter((entry) => entry.start <= offset && offset < entry.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  const call = index.calls
    .filter((entry) => entry.start <= offset && offset < entry.expressionEnd)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  return {
    symbol: call?.symbol || scope?.symbol || 'module',
    normalized_call: call?.normalized_call || normalizeMutationCall(fallback),
    scope_contract_sha256: call?.scope_contract_sha256 || scope?.scopeContractSha256 || structuralScopeSha256(index.sourceFile, index.sourceFile),
    code_offset: Boolean(call)
  };
}

export function mutationCallsiteSha256(input: {
  file: string;
  symbol: string;
  token: string;
  normalizedCall: string;
  scopeContractSha256: string;
}): string {
  return createHash('sha256')
    .update(`${input.file}\0${input.symbol}\0${input.token}\0${input.normalizedCall}\0${input.scopeContractSha256}`)
    .digest('hex');
}

export function normalizeMutationCall(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function mutationCallsiteOccurrences(hashes: string[]): number[] {
  const counts = new Map<string, number>();
  return hashes.map((hash) => {
    const occurrence = (counts.get(hash) || 0) + 1;
    counts.set(hash, occurrence);
    return occurrence;
  });
}

export function allRegexMatchIndexes(pattern: RegExp, value: string): number[] {
  const flags = [...new Set(`${pattern.flags.replace(/[gy]/g, '')}g`)].join('');
  const matcher = new RegExp(pattern.source, flags);
  const indexes: number[] = [];
  for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
    indexes.push(match.index);
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return indexes;
}

function collectAliasBindings(sourceFile: ts.SourceFile): AliasBinding[] {
  const aliases: AliasBinding[] = [];
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      collectImportBindings(node, node.moduleSpecifier.text, sourceFile, aliases);
    } else if (ts.isVariableDeclaration(node)) {
      collectVariableBindings(node, sourceFile, aliases);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const collectAssignments = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      collectAssignmentBinding(node, sourceFile, aliases);
    }
    ts.forEachChild(node, collectAssignments);
  };
  collectAssignments(sourceFile);
  return aliases;
}

function collectImportBindings(
  declaration: ts.ImportDeclaration,
  moduleName: string,
  sourceFile: ts.SourceFile,
  aliases: AliasBinding[]
): void {
  const clause = declaration.importClause;
  if (!clause) return;
  const moduleRoot = canonicalModuleRoot(moduleName);
  if (!moduleRoot) return;
  const scope = sourceFile;
  const start = declaration.getStart(sourceFile);
  if (clause.name) aliases.push({
    name: clause.name.text,
    start,
    scope,
    kind: 'import',
    canonical: moduleRoot
  });
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    aliases.push({
      name: bindings.name.text,
      start,
      scope,
      kind: 'import',
      canonical: moduleRoot
    });
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text || element.name.text;
      aliases.push({
        name: element.name.text,
        start,
        scope,
        kind: 'import',
        canonical: `${moduleRoot}.${imported}`
      });
    }
  }
}

function collectVariableBindings(
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
  aliases: AliasBinding[]
): void {
  const scope = lexicalBindingScope(
    declaration,
    sourceFile,
    variableDeclarationIsVar(declaration)
  );
  const start = declaration.getStart(sourceFile);
  const initializer = declaration.initializer;
  if (ts.isIdentifier(declaration.name)) {
    aliases.push({
      name: declaration.name.text,
      start,
      scope,
      kind: 'declaration',
      ...(initializer ? { expression: initializer } : {})
    });
    return;
  }
  if (!initializer || !ts.isObjectBindingPattern(declaration.name)) return;
  for (const element of declaration.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const property = element.propertyName
      ? propertyName(element.propertyName, sourceFile)
      : element.name.text;
    aliases.push({
      name: element.name.text,
      start,
      scope,
      kind: 'declaration',
      expression: initializer,
      suffix: property
    });
  }
}

function collectAssignmentBinding(
  assignment: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
  aliases: AliasBinding[]
): void {
  if (!ts.isIdentifier(assignment.left)) return;
  const name = assignment.left.text;
  const scope = aliases
    .filter((binding) =>
      binding.name === name
      && binding.kind === 'declaration'
      && nodeContains(binding.scope, assignment, sourceFile)
    )
    .sort((left, right) =>
      (left.scope.getEnd() - left.scope.getStart(sourceFile))
      - (right.scope.getEnd() - right.scope.getStart(sourceFile))
    )[0]?.scope || lexicalBindingScope(assignment, sourceFile, false);
  aliases.push({
    name,
    start: assignment.getStart(sourceFile),
    scope,
    kind: 'assignment',
    expression: assignment.right
  });
}

function resolveCanonicalExpression(
  expression: ts.Expression,
  atNode: ts.Node,
  aliases: AliasBinding[],
  sourceFile: ts.SourceFile,
  seen: Set<AliasBinding>
): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const binding = nearestAliasBinding(unwrapped.text, atNode, aliases, sourceFile, seen);
    if (!binding) return directIdentifierCanonical(unwrapped.text);
    seen.add(binding);
    const base = binding.canonical
      || (binding.expression
        ? resolveCanonicalExpression(binding.expression, binding.expression, aliases, sourceFile, seen)
        : null);
    seen.delete(binding);
    return base && binding.suffix ? `${base}.${binding.suffix}` : base;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    if (unwrapped.name.text === 'call' || unwrapped.name.text === 'apply') {
      return resolveCanonicalExpression(unwrapped.expression, atNode, aliases, sourceFile, seen);
    }
    const base = resolveCanonicalExpression(unwrapped.expression, atNode, aliases, sourceFile, seen);
    return base ? `${base}.${unwrapped.name.text}` : null;
  }
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression && ts.isStringLiteralLike(unwrapped.argumentExpression)) {
    if (unwrapped.argumentExpression.text === 'call' || unwrapped.argumentExpression.text === 'apply') {
      return resolveCanonicalExpression(unwrapped.expression, atNode, aliases, sourceFile, seen);
    }
    const base = resolveCanonicalExpression(unwrapped.expression, atNode, aliases, sourceFile, seen);
    return base ? `${base}.${unwrapped.argumentExpression.text}` : null;
  }
  if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression) && unwrapped.expression.name.text === 'bind') {
    return resolveCanonicalExpression(unwrapped.expression.expression, atNode, aliases, sourceFile, seen);
  }
  if (ts.isAwaitExpression(unwrapped)) {
    return resolveCanonicalExpression(unwrapped.expression, atNode, aliases, sourceFile, seen);
  }
  const importArgument = ts.isCallExpression(unwrapped) ? unwrapped.arguments[0] : undefined;
  if (ts.isCallExpression(unwrapped)
    && unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword
    && unwrapped.arguments.length === 1
    && importArgument
    && ts.isStringLiteralLike(importArgument)) {
    return canonicalModuleRoot(importArgument.text);
  }
  return null;
}

function nearestAliasBinding(
  name: string,
  atNode: ts.Node,
  aliases: AliasBinding[],
  sourceFile: ts.SourceFile,
  seen: Set<AliasBinding>
): AliasBinding | null {
  const at = atNode.getStart(sourceFile);
  return aliases
    .filter((binding) =>
      binding.name === name
      && binding.start <= at
      && !seen.has(binding)
      && nodeContains(binding.scope, atNode, sourceFile)
    )
    .sort((left, right) => {
      const scopeDifference = (left.scope.getEnd() - left.scope.getStart(sourceFile))
        - (right.scope.getEnd() - right.scope.getStart(sourceFile));
      return scopeDifference || right.start - left.start;
    })[0] || null;
}

function directIdentifierCanonical(name: string): string | null {
  if ([
    'fs',
    'fsp',
    'process',
    'runProcess',
    'spawn',
    'spawnSync',
    'writeFileSync',
    'rmSync',
    'unlink',
    'unlinkSync',
    'rename',
    'renameSync',
    'chmod',
    'chmodSync'
  ].includes(name) || /^guarded[A-Z]/.test(name)) {
    return name;
  }
  return null;
}

function writtenExpressionPath(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const base = writtenExpressionPath(unwrapped.expression);
    return base ? `${base}.${unwrapped.name.text}` : null;
  }
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression && ts.isStringLiteralLike(unwrapped.argumentExpression)) {
    const base = writtenExpressionPath(unwrapped.expression);
    return base ? `${base}.${unwrapped.argumentExpression.text}` : null;
  }
  return null;
}

function canonicalModuleRoot(moduleName: string): string | null {
  if (moduleName === 'node:fs' || moduleName === 'fs') return 'fs';
  if (moduleName === 'node:fs/promises' || moduleName === 'fs/promises') return 'fsp';
  if (moduleName === 'node:child_process' || moduleName === 'child_process') return 'child_process';
  return null;
}

function lexicalBindingScope(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functionScoped: boolean
): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isFunctionLike(current)) return current;
    if (!functionScoped && ts.isBlock(current)) return current;
    current = current.parent;
  }
  return sourceFile;
}

function variableDeclarationIsVar(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list)
    && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
}

function nodeContains(container: ts.Node, node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const position = node.getStart(sourceFile);
  return container.getStart(sourceFile) <= position && position < container.getEnd();
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function structuralScopeSha256(node: ts.Node, sourceFile: ts.SourceFile): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    node.getText(sourceFile)
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return createHash('sha256').update(tokens.join('\0')).digest('hex');
}

function symbolForNode(node: ts.Node, parentSymbol: string, sourceFile: ts.SourceFile): string | null {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name?.text || `${parentSymbol}.class@${lineOf(node, sourceFile)}`;
  }
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text || `${parentSymbol}.function@${lineOf(node, sourceFile)}`;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return `${parentSymbol}.${propertyName(node.name, sourceFile)}`;
  }
  if (ts.isConstructorDeclaration(node)) return `${parentSymbol}.constructor`;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return `${parentSymbol}.${propertyName(parent.name, sourceFile)}`;
    }
    return `${parentSymbol}.callback@${lineOf(node, sourceFile)}`;
  }
  return null;
}

function propertyName(name: ts.PropertyName | ts.BindingName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return normalizeMutationCall(name.getText(sourceFile)).slice(0, 80);
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
