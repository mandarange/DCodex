/**
 * Claim prose on the node, and what must never ride along with it.
 *
 * Two things are asserted here and they pull against each other, which is why
 * they live in one file. A claim has to be reachable by its own words — the
 * defect these tests close was that claim text was hashed, measured and then
 * discarded, so no claim was retrievable by anything it actually said, in any
 * language. And claim text is the most free-form string in the graph, so it is
 * also the most plausible carrier of a pasted key or a machine path.
 *
 * The index canary is the load-bearing half. `runtime-index`'s lexicon refuses
 * to *tokenize* a secret-shaped token, but `encodeContextIndex` interns every
 * metadata value verbatim into the string table — so a value that only the
 * tokenizer rejects is still resident in the published bytes. Searching the
 * whole encoded index for the literal is the only assertion that covers that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CONTEXT_GRAPH_SCHEMA, type ContextGraphFragment, type ContextGraphNode } from '../../../contracts.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../../../query/ranking-config.js';
import { openContextIndex } from '../../../runtime-index/reader.js';
import { encodeContextIndex } from '../../../runtime-index/writer.js';
import { makeWorkspace, manifestEntry, removeWorkspace, runExtractor, writeContextPack } from './fixtures.js';

/** Key-shaped literals; every one is synthetic and none is a real credential. */
const SECRET_TOKEN = 'sk-proj-Ab12Cd34Ef56Gh78Ij90Kl';
const ABSOLUTE_PATH = '/etc/sneakoscope/leaked.conf';
const HOME_PATH = '~/.codex/auth-leaked.json';
const TEMP_PATH = '/private/tmp/sks-leaked-9f2a/dump.txt';

/**
 * The shapes the repository redactor's prefix list does not name. Each of these
 * was measured reaching the published index bytes before the extractor grew a
 * shape guard, and the last three were searchable there by their segments.
 */
const UNPREFIXED_TOKEN = 'Xq7pLm2Rt9Wz4Bv6Nc8Ka1Hj3Sd5Gf0';
/**
 * The same entropy in base64url. Its `-` and `_` are payload, so every run
 * between them is under the 20-character floor and the token survives a guard
 * that only judges runs as they appear — which is the encoding real tokens use.
 */
const BASE64URL_TOKEN = 'Vp9-mK2xQ_7bNz4Rt6Lw-Yc1Hj8Ds3Fg5Ab0Ke7Mn2';
/**
 * The same entropy in *standard* base64, whose payload characters are `+` and
 * `/` instead. It is here because the first guard rejoined only `-` and `_`,
 * which closed base64url and left this at 87.0% — the identical defect one
 * encoding over, invisible because the shape that was tested was the shape that
 * had just been fixed. A second encoding is the cheapest way to keep the rule
 * honest about what it actually covers.
 */
const BASE64_TOKEN = 'FVECbbF+6wT2ZyXZRr8Ge4ibqC+lalpCaj/WCj9rumk=';
const HEX_TOKEN = 'a3f9'.repeat(16);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.QkFEU0lHTkFUVVJF';
const EMAIL = 'alice.hidden@example.invalid';
const IPV4 = '10.42.7.199';

function claimByLabel(nodes: readonly ContextGraphNode[], label: string): ContextGraphNode {
  const found = nodes.find((node) => node.kind === 'wiki_claim' && node.label === label);
  assert.ok(found, `expected a wiki_claim node labelled ${label}`);
  return found;
}

function claimText(node: ContextGraphNode): string {
  const value = node.metadata.text;
  assert.equal(typeof value, 'string', `claim ${node.label} carries no text`);
  return value as string;
}

/** Every string the fragment could carry, flattened — ids, labels, paths, metadata, issues. */
function fragmentStrings(fragment: ContextGraphFragment): string {
  return JSON.stringify(fragment);
}

interface BuiltIndex {
  bytes: Uint8Array;
  nodeIndexOf: ReadonlyMap<string, number>;
}

/** Encodes the fragment as a real SKSCG2 index with the shipped lexicon tuning. */
function buildIndex(fragment: ContextGraphFragment): BuiltIndex {
  const nodes = [...fragment.nodes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const edges = [...fragment.edges].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const written = encodeContextIndex({
    snapshot: {
      schema: CONTEXT_GRAPH_SCHEMA,
      schemaRevision: '1.0.0',
      snapshotHash: crypto.createHash('sha256').update('claim-text-test').digest('hex'),
      nodes,
      edges,
      cycles: [],
      extractors: [],
      nodeCount: nodes.length,
      edgeCount: edges.length
    },
    configHash: new Uint8Array(32),
    schemaRevision: 1,
    lexicon: CONTEXT_GRAPH_LEXICON_CONFIG
  });
  return { bytes: written.bytes, nodeIndexOf: new Map(nodes.map((node, position) => [node.id, position])) };
}

/** True when the literal appears anywhere in the encoded bytes, as UTF-8. */
function indexCarries(bytes: Uint8Array, literal: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(literal, 'utf8'));
}

/** Resolves a query word through the reader and reports whether it reaches the node. */
function retrieves(built: BuiltIndex, word: string, nodeId: string): boolean {
  const reader = openContextIndex(built.bytes);
  const termId = reader.termId(word.normalize('NFKC').toLowerCase());
  if (termId < 0) return false;
  const slice = reader.lexical([termId], { postingCapPerTerm: 4096, candidateBudget: 4096 });
  const want = built.nodeIndexOf.get(nodeId);
  for (let position = 0; position < slice.length; position += 1) {
    if (slice.node(position) === want) return true;
  }
  return false;
}

test('a claim is retrievable by a word of its own prose, in English and in Korean', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        {
          id: 'en-claim',
          text: 'the retrieval kernel enforces a bounded budget before any lane runs',
          source_paths: ['src/a.ts'],
          status: 'supported'
        },
        {
          id: 'ko-claim',
          // The case that exposed the defect: Korean reaches the index through
          // no other field, so a discarded text field is total loss here.
          text: '검색 커널은 레인이 실행되기 전에 예산을 강제한다',
          source_paths: ['src/b.ts'],
          status: 'supported'
        }
      ],
      entries: [manifestEntry(root, 'src/a.ts'), manifestEntry(root, 'src/b.ts')]
    });

    const fragment = await runExtractor(root);
    const english = claimByLabel(fragment.nodes, 'en-claim');
    const korean = claimByLabel(fragment.nodes, 'ko-claim');
    assert.equal(claimText(english), 'the retrieval kernel enforces a bounded budget before any lane runs');
    assert.equal(claimText(korean), '검색 커널은 레인이 실행되기 전에 예산을 강제한다');
    assert.equal(english.metadata.text_redacted, undefined, 'clean prose must not be reported as redacted');

    const built = buildIndex(fragment);
    // `budget` and `예산` appear in the claim's own text and nowhere in its id,
    // label or path, so a hit can only have come from the stored prose.
    assert.ok(retrieves(built, 'budget', english.id), 'an English claim must be reachable by its own word');
    assert.ok(retrieves(built, 'enforces', english.id));
    assert.ok(retrieves(built, '예산', korean.id), 'a Korean claim must be reachable by its own word');
    assert.ok(retrieves(built, '커널', korean.id));

    // The control from the release record: the same query before the fix
    // resolved to no term at all, so assert the term exists as well as hits.
    const reader = openContextIndex(built.bytes);
    assert.ok(reader.termId('budget') >= 0, 'a prose word must be interned as a term');
    assert.ok(reader.termId('예산') >= 0, 'a Korean n-gram must be interned as a term');
  } finally {
    removeWorkspace(root);
  }
});

test('a secret token and machine paths in claim prose reach neither the node nor the index bytes', async () => {
  const root = makeWorkspace();
  try {
    writeContextPack(root, {
      claims: [
        {
          id: 'secret-claim',
          text: `the deploy lane authenticates with ${SECRET_TOKEN} before it publishes`,
          source_paths: ['src/a.ts']
        },
        {
          id: 'absolute-claim',
          text: `the collector reads ${ABSOLUTE_PATH} at startup`,
          source_paths: ['src/a.ts']
        },
        {
          id: 'home-claim',
          text: `credentials are cached in ${HOME_PATH} between runs`,
          source_paths: ['src/b.ts']
        },
        {
          id: 'temp-claim',
          text: `the failing run wrote ${TEMP_PATH} and left it behind`,
          source_paths: ['src/b.ts']
        }
      ],
      entries: [manifestEntry(root, 'src/a.ts'), manifestEntry(root, 'src/b.ts')]
    });

    const fragment = await runExtractor(root);
    const leaks = [SECRET_TOKEN, ABSOLUTE_PATH, HOME_PATH, TEMP_PATH];

    // 1. Nothing hostile survives anywhere in the fragment, node metadata included.
    const serialized = fragmentStrings(fragment);
    for (const leak of leaks) {
      assert.ok(!serialized.includes(leak), `fragment must not carry ${leak}`);
    }

    // 2. Each claim still exists as a node — a leak-safe field is not a reason
    //    to lose the claim, its citations or its trust.
    const secret = claimByLabel(fragment.nodes, 'secret-claim');
    const absolute = claimByLabel(fragment.nodes, 'absolute-claim');
    const home = claimByLabel(fragment.nodes, 'home-claim');
    const temp = claimByLabel(fragment.nodes, 'temp-claim');
    for (const node of [secret, absolute, home, temp]) {
      assert.equal(node.metadata.text_redacted, true, `${node.label} must report its prose as redacted`);
      assert.equal(node.metadata.citation_count, 1);
    }

    // 3. A recognized key shape is cut out of the prose; the sentence survives.
    assert.ok(claimText(secret).includes('the deploy lane authenticates with'));
    assert.ok(!claimText(secret).includes('sk-proj-'));

    // 4. A path-carrying claim loses the whole field rather than part of it, and
    //    the redaction marker is not stored in its place.
    for (const node of [absolute, home, temp]) {
      assert.equal(node.metadata.text, undefined, `${node.label} must store no prose at all`);
      assert.ok(!JSON.stringify(node.metadata).includes('redacted-path'));
    }

    // 5. The canary: nothing hostile appears anywhere in the published bytes.
    //    The positive control comes first — a canary over bytes that carry no
    //    claim prose at all would pass while proving nothing.
    const built = buildIndex(fragment);
    assert.ok(
      indexCarries(built.bytes, 'the deploy lane authenticates with'),
      'the surviving prose must be present in the bytes, or the canary below is vacuous'
    );
    for (const leak of leaks) {
      assert.ok(!indexCarries(built.bytes, leak), `index bytes must not carry ${leak}`);
    }
    for (const fragmentOfLeak of ['/etc/sneakoscope', 'auth-leaked', 'sks-leaked-9f2a', 'Ab12Cd34Ef56Gh78Ij90Kl']) {
      assert.ok(!indexCarries(built.bytes, fragmentOfLeak), `index bytes must not carry ${fragmentOfLeak}`);
    }
  } finally {
    removeWorkspace(root);
  }
});

test('an unprefixed key, a JWT, an address and an IP reach neither the node nor the index bytes', async () => {
  const root = makeWorkspace();
  try {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['entropy-claim', UNPREFIXED_TOKEN],
      ['base64url-claim', BASE64URL_TOKEN],
      ['base64-claim', BASE64_TOKEN],
      ['hex-claim', HEX_TOKEN],
      ['jwt-claim', JWT],
      ['email-claim', EMAIL],
      ['ipv4-claim', IPV4]
    ];
    writeContextPack(root, {
      claims: cases.map(([id, value]) => ({
        id,
        text: `the collector lane carried ${value} through the pipeline unchanged`,
        source_paths: ['src/a.ts']
      })),
      entries: [manifestEntry(root, 'src/a.ts')]
    });

    const fragment = await runExtractor(root);
    const serialized = fragmentStrings(fragment);
    const built = buildIndex(fragment);
    const reader = openContextIndex(built.bytes);

    for (const [id, value] of cases) {
      const node = claimByLabel(fragment.nodes, id);
      // The whole field collapses. Cutting the span out would publish the rest
      // of a credential, and it is the surviving part that gets indexed.
      assert.equal(node.metadata.text, undefined, `${id} must store no prose`);
      assert.equal(node.metadata.text_redacted, true, `${id} must report its prose as redacted`);
      assert.equal(node.metadata.citation_count, 1, `${id} must keep its citation`);
      assert.ok(!serialized.includes(value), `fragment must not carry ${id}'s value`);
      assert.ok(!indexCarries(built.bytes, value), `index bytes must not carry ${id}'s value`);
      // The three non-entropy shapes were searchable by their segments, which is
      // worse than merely resident; assert the segments are gone as terms too.
      for (const segment of value.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 3)) {
        assert.equal(reader.termId(segment), -1, `${id} must leave no searchable term "${segment}"`);
      }
    }
  } finally {
    removeWorkspace(root);
  }
});

test('the shape guard leaves ordinary technical prose alone', async () => {
  const root = makeWorkspace();
  try {
    // Every one of these is a plausible claim sentence and none may collapse:
    // long identifiers, semver, counts, short hashes and dotted schema names are
    // what claim prose is actually made of.
    const sentences: ReadonlyArray<readonly [string, string]> = [
      ['identifier-claim', 'ContextGraphSnapshotBuilder calls createReleaseStampProof before sealing the interner'],
      ['version-claim', 'sneakoscope 8.6.4 raised the frontier budget from 1200 to 4096 across 27 modules'],
      ['schema-claim', 'the sks.triwiki-proof-card.v1 schema pins tool_versions and package_lock_hash together'],
      ['digest-claim', 'generation 1f91c760d70e612a supersedes 2947bec8 for the same snapshot'],
      ['export-claim', 'native-sks-menubar is a module at native/sks-menubar with exports numberOfRows and tableView'],
      ['prose-claim', 'the retrieval kernel enforces a bounded budget before any lane runs at all'],
      // Widening the rejoin to `+` `/` `=` for standard base64 makes the guard
      // read across those characters, so the prose that actually contains them —
      // paths and ratios — is what has to be pinned, not merely reasoned about.
      ['path-claim', 'see src/core/search/context.ts and src/core/triwiki/context-graph/query/kernel.ts for the seam'],
      ['ratio-claim', 'the a/b split ran 3/4 against 1/2 and the p95 held at 12ms']
    ];
    writeContextPack(root, {
      claims: sentences.map(([id, text]) => ({ id, text, source_paths: ['src/a.ts'] })),
      entries: [manifestEntry(root, 'src/a.ts')]
    });

    const fragment = await runExtractor(root);
    for (const [id, text] of sentences) {
      const node = claimByLabel(fragment.nodes, id);
      assert.equal(claimText(node), text, `${id} must survive the shape guard intact`);
      assert.equal(node.metadata.text_redacted, undefined, `${id} must not be reported as redacted`);
    }
  } finally {
    removeWorkspace(root);
  }
});

test('the entropy proxy costs a named class of identifier, and the cost is pinned not hidden', async () => {
  const root = makeWorkspace();
  try {
    // These are false positives and this test exists to keep them visible.
    // Each is a CamelCase identifier of at least 20 characters embedding a
    // number, which is the one shape the integer entropy proxy cannot tell from
    // key material. Two facts make it the accepted trade rather than a bug:
    //
    // - The index tokenizer already refuses these tokens whole, before casing
    //   and before camel-splitting (`emitLatinRun`), so none of them was ever
    //   searchable. Storing them would put an unsearchable token in the bytes.
    // - Measured on this repository's real context pack, 0 of 24 claims trip it.
    //
    // What it does cost is blast radius: the collapse is all-or-nothing, so the
    // claim loses its *other* words too. If that ever shows up as a real recall
    // hole, this test is where the evidence starts.
    const identifiers = ['parseUtf8Base64Payload', 'runCrk2LexiconBuilder', 'sha256HashOfTheManifest'];
    writeContextPack(root, {
      claims: identifiers.map((identifier, position) => ({
        id: `identifier-${position}`,
        text: `the lane calls ${identifier} while resolving the frontier budget`,
        source_paths: ['src/a.ts']
      })),
      entries: [manifestEntry(root, 'src/a.ts')]
    });

    const fragment = await runExtractor(root);
    for (let position = 0; position < identifiers.length; position += 1) {
      const node = claimByLabel(fragment.nodes, `identifier-${position}`);
      assert.equal(node.metadata.text, undefined, `${identifiers[position]} collapses its claim's prose`);
      assert.equal(node.metadata.text_redacted, true);
    }

    // The counterpart that makes the class a *class*: the same sentence with a
    // digit-free identifier of the same length keeps every word.
    writeContextPack(root, {
      claims: [{ id: 'control', text: 'the lane calls parseBaseTextPayload while resolving the frontier budget', source_paths: ['src/a.ts'] }],
      entries: [manifestEntry(root, 'src/a.ts')]
    });
    const control = await runExtractor(root);
    assert.equal(
      claimText(claimByLabel(control.nodes, 'control')),
      'the lane calls parseBaseTextPayload while resolving the frontier budget'
    );
  } finally {
    removeWorkspace(root);
  }
});

test('what the redactor removes never then trips the fragment guard', async () => {
  const root = makeWorkspace();
  try {
    // `safeText` redacts with the repository pattern list and `guardNode`
    // re-tests the result with `containsPlaintextSecret` from the same list,
    // refusing the whole node if anything still matches. The two are only
    // symmetric by construction, and a node refused here loses its citations
    // and its trust, not merely its prose — so the symmetry is asserted rather
    // than assumed.
    writeContextPack(root, {
      claims: [
        { id: 'bearer-claim', text: 'the probe sent Bearer abcdefghijklmnop0123456789 and got a 401', source_paths: ['src/a.ts'] },
        { id: 'kv-claim', text: 'the run exported api_key=Zx91QmWo22Lp7Vn4 before the deploy step', source_paths: ['src/a.ts'] },
        { id: 'github-claim', text: 'the token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6 was rotated at once', source_paths: ['src/a.ts'] },
        { id: 'aws-claim', text: 'the role assumed AKIAIOSFODNN7EXAMPLE in the staging account', source_paths: ['src/a.ts'] }
      ],
      entries: [manifestEntry(root, 'src/a.ts')]
    });

    const fragment = await runExtractor(root);
    assert.equal(
      fragment.issues.filter((issue) => issue.code === 'secret_like_value').length,
      0,
      'a value this layer redacted must not then be refused by the fragment guard'
    );
    for (const id of ['bearer-claim', 'kv-claim', 'github-claim', 'aws-claim']) {
      const node = claimByLabel(fragment.nodes, id);
      assert.equal(node.metadata.text_redacted, true);
      assert.equal(node.metadata.citation_count, 1, `${id} must survive as a node with its citation`);
    }
  } finally {
    removeWorkspace(root);
  }
});

test('stored prose is bounded, and the bound is visible rather than silent', async () => {
  const root = makeWorkspace();
  try {
    const long = `the compiler lane records ${'attribution '.repeat(40)}for every selected candidate`;
    writeContextPack(root, {
      claims: [{ id: 'long-claim', text: long, source_paths: ['src/a.ts'] }],
      entries: [manifestEntry(root, 'src/a.ts')]
    });

    const fragment = await runExtractor(root);
    const node = claimByLabel(fragment.nodes, 'long-claim');
    const stored = claimText(node);
    assert.ok(stored.length <= 160, `stored prose must respect the metadata bound, got ${stored.length}`);
    assert.ok(stored.startsWith('the compiler lane records attribution'));
    // `text_length` keeps measuring the declared prose, so the difference
    // between it and the stored text is what tells a reader it was cut.
    assert.equal(node.metadata.text_length, long.length);
    assert.ok((node.metadata.text_length as number) > stored.length);
    // Truncation alone is not redaction, and must not be reported as such.
    assert.equal(node.metadata.text_redacted, undefined);
    assert.equal(node.metadata.redacted, undefined, 'a merely long claim must not be flagged by the fragment guard');
  } finally {
    removeWorkspace(root);
  }
});
