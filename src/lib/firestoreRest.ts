// lib/firestoreRest.ts
// Firestore REST API client for Cloudflare Workers.
// firebase-admin/firestore ka drop-in replacement — sirf woh surface jo game APIs use karti hain:
//   Timestamp, FieldValue, db.collection().doc().get/set/update/delete,
//   queries (where/orderBy/limit), runTransaction, batch.
// gRPC nahi — pure fetch() + REST, isliye Workers pe chalta hai.

import { getAccessToken } from './googleAuth';

// ─── Timestamp ────────────────────────────────────────────────────────────────

export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  // Admin SDK internals compat — kuch game code `_seconds` padhta hai
  readonly _seconds: number;
  readonly _nanoseconds: number;

  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
    this._seconds = seconds;
    this._nanoseconds = nanoseconds;
  }

  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }

  static fromDate(date: Date): Timestamp {
    return Timestamp.fromMillis(date.getTime());
  }

  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.floor((ms - seconds * 1000) * 1e6);
    return new Timestamp(seconds, nanoseconds);
  }

  toDate(): Date {
    return new Date(this.toMillis());
  }

  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }

  isEqual(other: Timestamp): boolean {
    return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds;
  }

  toISOString(): string {
    return new Date(this.seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '') +
      '.' + String(this.nanoseconds).padStart(9, '0') + 'Z';
  }
}

// ─── FieldValue sentinels ─────────────────────────────────────────────────────

type SentinelKind = 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';

class FieldValueSentinel {
  constructor(
    readonly kind: SentinelKind,
    readonly operand?: number,
    readonly elements?: any[],
  ) {}
}

export const FieldValue = {
  serverTimestamp: () => new FieldValueSentinel('serverTimestamp'),
  increment: (n: number) => new FieldValueSentinel('increment', n),
  arrayUnion: (...elements: any[]) => new FieldValueSentinel('arrayUnion', undefined, elements),
  arrayRemove: (...elements: any[]) => new FieldValueSentinel('arrayRemove', undefined, elements),
  delete: () => new FieldValueSentinel('delete'),
};

// ─── Value encode / decode ────────────────────────────────────────────────────

function encodeValue(v: any): any {
  if (v === null) return { nullValue: null };
  if (v instanceof Timestamp) return { timestampValue: v.toISOString() };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.filter(x => x !== undefined).map(encodeValue) } };
  }
  if (v instanceof FieldValueSentinel) {
    throw new Error('FieldValue sentinel cannot be nested inside an array value');
  }
  if (typeof v === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (val instanceof FieldValueSentinel) {
        throw new Error('FieldValue sentinel inside array/map value is not supported here');
      }
      fields[k] = encodeValue(val);
    }
    return { mapValue: { fields } };
  }
  throw new Error(`Cannot encode value of type ${typeof v}`);
}

function decodeValue(v: any): any {
  if (v === null || v === undefined) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Timestamp.fromMillis(Date.parse(v.timestampValue));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decodeValue(val);
    return out;
  }
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  return null;
}

// ─── Field paths ──────────────────────────────────────────────────────────────

const BARE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeSegment(seg: string): string {
  if (BARE_SEGMENT.test(seg)) return seg;
  return '`' + seg.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

function joinPath(segments: string[]): string {
  return segments.map(escapeSegment).join('.');
}

// ─── Write building ───────────────────────────────────────────────────────────

interface BuiltWrite {
  fields: Record<string, any>;
  transforms: any[];       // fieldTransforms
  maskPaths: string[];     // updateMask.fieldPaths
}

function sentinelToTransform(fieldPath: string, s: FieldValueSentinel): any {
  switch (s.kind) {
    case 'serverTimestamp':
      return { fieldPath, setToServerValue: 'REQUEST_TIME' };
    case 'increment':
      return { fieldPath, increment: encodeValue(s.operand!) };
    case 'arrayUnion':
      return { fieldPath, appendMissingElements: { values: (s.elements || []).map(encodeValue) } };
    case 'arrayRemove':
      return { fieldPath, removeAllFromArray: { values: (s.elements || []).map(encodeValue) } };
    default:
      throw new Error(`Sentinel ${s.kind} cannot be a transform`);
  }
}

// set(): keys literal (dots split NAHI hote), sentinels kisi bhi depth pe
function buildSetWrite(data: Record<string, any>): BuiltWrite {
  const transforms: any[] = [];

  function walk(obj: Record<string, any>, pathSegs: string[]): Record<string, any> {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const segs = [...pathSegs, k];
      if (v instanceof FieldValueSentinel) {
        if (v.kind === 'delete') continue; // set() mein delete ka matlab: field mat likho
        transforms.push(sentinelToTransform(joinPath(segs), v));
        continue;
      }
      if (v !== null && typeof v === 'object' && !(v instanceof Timestamp) &&
          !(v instanceof Date) && !Array.isArray(v)) {
        fields[k] = { mapValue: { fields: walk(v, segs) } };
      } else {
        fields[k] = encodeValue(v);
      }
    }
    return fields;
  }

  return { fields: walk(data, []), transforms, maskPaths: [] };
}

// update(): top-level keys DOTTED PATHS hain (admin SDK semantics),
// values ke andar sentinels bhi handle hote hain
function buildUpdateWrite(data: Record<string, any>): BuiltWrite {
  const transforms: any[] = [];
  const maskPaths: string[] = [];
  const fields: Record<string, any> = {};

  // nested map walk — sentinels nikal ke transforms mein daalo
  function walkMap(obj: Record<string, any>, pathSegs: string[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const segs = [...pathSegs, k];
      if (v instanceof FieldValueSentinel) {
        if (v.kind === 'delete')
          throw new Error('Nested FieldValue.delete() inside a map is not supported in update()');
        transforms.push(sentinelToTransform(joinPath(segs), v));
        continue;
      }
      if (v !== null && typeof v === 'object' && !(v instanceof Timestamp) &&
          !(v instanceof Date) && !Array.isArray(v)) {
        out[k] = { mapValue: { fields: walkMap(v, segs) } };
      } else {
        out[k] = encodeValue(v);
      }
    }
    return out;
  }

  for (const [key, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const segs = key.split('.'); // dotted path semantics
    const fieldPath = joinPath(segs);

    if (v instanceof FieldValueSentinel) {
      if (v.kind === 'delete') {
        maskPaths.push(fieldPath); // mask mein hai, fields mein nahi → delete
      } else {
        transforms.push(sentinelToTransform(fieldPath, v));
      }
      continue;
    }

    maskPaths.push(fieldPath);

    // fields object mein nested structure banao path ke hisaab se
    let cursor = fields;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (!cursor[seg]) cursor[seg] = { mapValue: { fields: {} } };
      cursor = cursor[seg].mapValue.fields;
    }
    const leaf = segs[segs.length - 1];
    if (v !== null && typeof v === 'object' && !(v instanceof Timestamp) &&
        !(v instanceof Date) && !Array.isArray(v)) {
      cursor[leaf] = { mapValue: { fields: walkMap(v, segs) } };
    } else {
      cursor[leaf] = encodeValue(v);
    }
  }

  return { fields, transforms, maskPaths };
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class FirestoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'FirestoreError';
  }
}

async function firestoreFetch(url: string, init: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    let code = 'UNKNOWN';
    let message = `Firestore request failed (${res.status})`;
    try {
      const body: any = await res.json();
      const err = Array.isArray(body) ? body[0]?.error : body?.error;
      if (err) {
        code = err.status || code;
        message = err.message || message;
      }
    } catch { /* body parse fail — generic error hi throw karo */ }
    throw new FirestoreError(message, code, res.status);
  }
  return res.json();
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

export class DocumentSnapshot {
  constructor(
    readonly ref: DocumentReference,
    readonly exists: boolean,
    private readonly _data: Record<string, any> | undefined,
  ) {}

  get id(): string { return this.ref.id; }

  data(): Record<string, any> | undefined { return this._data; }

  get(field: string): any {
    let cur: any = this._data;
    for (const seg of field.split('.')) {
      if (cur == null) return undefined;
      cur = cur[seg];
    }
    return cur;
  }
}

export class QuerySnapshot {
  constructor(readonly docs: DocumentSnapshot[]) {}
  get empty(): boolean { return this.docs.length === 0; }
  get size(): number { return this.docs.length; }
  forEach(cb: (doc: DocumentSnapshot) => void): void { this.docs.forEach(cb); }
}

function snapshotFromRest(db: Firestore, doc: any): DocumentSnapshot {
  // doc.name = projects/{pid}/databases/(default)/documents/{path...}
  const relPath = doc.name.split('/documents/')[1];
  const ref = new DocumentReference(db, relPath);
  const data: Record<string, any> = {};
  for (const [k, v] of Object.entries(doc.fields || {})) data[k] = decodeValue(v);
  return new DocumentSnapshot(ref, true, data);
}

// ─── References ──────────────────────────────────────────────────────────────

const AUTO_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function autoId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += AUTO_ID_CHARS[b % 62];
  return id;
}

export class DocumentReference {
  constructor(readonly _db: Firestore, readonly path: string) {}

  get id(): string {
    const segs = this.path.split('/');
    return segs[segs.length - 1];
  }

  get _name(): string {
    return `${this._db._docsRoot}/${this.path}`;
  }

  collection(id: string): CollectionReference {
    return new CollectionReference(this._db, `${this.path}/${id}`);
  }

  async get(): Promise<DocumentSnapshot> {
    const token = await getAccessToken();
    const res = await fetch(`${this._db._baseUrl}/${this.path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return new DocumentSnapshot(this, false, undefined);
    }
    if (!res.ok) {
      let message = `Firestore get failed (${res.status})`;
      let code = 'UNKNOWN';
      try {
        const body: any = await res.json();
        if (body?.error) { message = body.error.message; code = body.error.status; }
      } catch { /* ignore */ }
      throw new FirestoreError(message, code, res.status);
    }
    const doc = await res.json();
    return snapshotFromRest(this._db, doc);
  }

  async set(data: Record<string, any>, options?: { merge?: boolean }): Promise<void> {
    await this._db._commit([this._buildSet(data, options)]);
  }

  async update(data: Record<string, any>): Promise<void> {
    await this._db._commit([this._buildUpdate(data)]);
  }

  async delete(): Promise<void> {
    await this._db._commit([{ delete: this._name }]);
  }

  _buildSet(data: Record<string, any>, options?: { merge?: boolean }): any {
    const { fields, transforms, maskPaths } = options?.merge
      ? buildUpdateWrite(data)   // merge ≈ update semantics, bina precondition ke
      : buildSetWrite(data);
    const write: any = { update: { name: this._name, fields } };
    if (options?.merge) write.updateMask = { fieldPaths: maskPaths };
    if (transforms.length) write.updateTransforms = transforms;
    return write;
  }

  _buildUpdate(data: Record<string, any>): any {
    const { fields, transforms, maskPaths } = buildUpdateWrite(data);
    const write: any = {
      update: { name: this._name, fields },
      updateMask: { fieldPaths: maskPaths },
      currentDocument: { exists: true }, // admin SDK: update() fails agar doc nahi hai
    };
    if (transforms.length) write.updateTransforms = transforms;
    return write;
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

const OP_MAP: Record<string, string> = {
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'in': 'IN',
  'not-in': 'NOT_IN',
  'array-contains': 'ARRAY_CONTAINS',
  'array-contains-any': 'ARRAY_CONTAINS_ANY',
};

export class Query {
  constructor(
    readonly _db: Firestore,
    readonly _collectionId: string,
    readonly _filters: any[] = [],
    readonly _orderBy: any[] = [],
    readonly _limit: number | null = null,
  ) {}

  where(field: string, op: string, value: any): Query {
    const restOp = OP_MAP[op];
    if (!restOp) throw new Error(`Unsupported operator: ${op}`);
    const encoded = (op === 'in' || op === 'not-in' || op === 'array-contains-any')
      ? { arrayValue: { values: (value as any[]).map(encodeValue) } }
      : encodeValue(value);
    const filter = {
      fieldFilter: { field: { fieldPath: field }, op: restOp, value: encoded },
    };
    return new Query(this._db, this._collectionId, [...this._filters, filter], this._orderBy, this._limit);
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Query {
    const ob = { field: { fieldPath: field }, direction: direction === 'desc' ? 'DESCENDING' : 'ASCENDING' };
    return new Query(this._db, this._collectionId, this._filters, [...this._orderBy, ob], this._limit);
  }

  limit(n: number): Query {
    return new Query(this._db, this._collectionId, this._filters, this._orderBy, n);
  }

  async get(): Promise<QuerySnapshot> {
    const structuredQuery: any = {
      from: [{ collectionId: this._collectionId }],
    };
    if (this._filters.length === 1) {
      structuredQuery.where = this._filters[0];
    } else if (this._filters.length > 1) {
      structuredQuery.where = { compositeFilter: { op: 'AND', filters: this._filters } };
    }
    if (this._orderBy.length) structuredQuery.orderBy = this._orderBy;
    if (this._limit !== null) structuredQuery.limit = this._limit;

    const rows = await firestoreFetch(`${this._db._baseUrl}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });
    const docs = (rows as any[])
      .filter(r => r.document)
      .map(r => snapshotFromRest(this._db, r.document));
    return new QuerySnapshot(docs);
  }
}

export class CollectionReference extends Query {
  constructor(db: Firestore, readonly path: string) {
    const segs = path.split('/');
    super(db, segs[segs.length - 1]);
  }

  doc(id?: string): DocumentReference {
    return new DocumentReference(this._db, `${this.path}/${id ?? autoId()}`);
  }

  async add(data: Record<string, any>): Promise<DocumentReference> {
    const ref = this.doc();
    // set() with exists:false precondition — auto-ID collision pe fail ho
    const write = ref._buildSet(data);
    write.currentDocument = { exists: false };
    await this._db._commit([write]);
    return ref;
  }
}

// ─── Transaction ──────────────────────────────────────────────────────────────

export class Transaction {
  _writes: any[] = [];

  constructor(readonly _db: Firestore, readonly _txId: string) {}

  async get(ref: DocumentReference): Promise<DocumentSnapshot> {
    const body = { documents: [ref._name], transaction: this._txId };
    const rows = await firestoreFetch(`${this._db._baseUrl}:batchGet`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const row = (rows as any[])[0];
    if (row?.found) return snapshotFromRest(this._db, row.found);
    return new DocumentSnapshot(ref, false, undefined);
  }

  set(ref: DocumentReference, data: Record<string, any>, options?: { merge?: boolean }): this {
    this._writes.push(ref._buildSet(data, options));
    return this;
  }

  update(ref: DocumentReference, data: Record<string, any>): this {
    this._writes.push(ref._buildUpdate(data));
    return this;
  }

  delete(ref: DocumentReference): this {
    this._writes.push({ delete: ref._name });
    return this;
  }
}

// ─── WriteBatch ───────────────────────────────────────────────────────────────

export class WriteBatch {
  private _writes: any[] = [];

  constructor(readonly _db: Firestore) {}

  set(ref: DocumentReference, data: Record<string, any>, options?: { merge?: boolean }): this {
    this._writes.push(ref._buildSet(data, options));
    return this;
  }

  update(ref: DocumentReference, data: Record<string, any>): this {
    this._writes.push(ref._buildUpdate(data));
    return this;
  }

  delete(ref: DocumentReference): this {
    this._writes.push({ delete: ref._name });
    return this;
  }

  async commit(): Promise<void> {
    if (this._writes.length === 0) return;
    await this._db._commit(this._writes);
  }
}

// ─── Firestore (db) ───────────────────────────────────────────────────────────

const MAX_TX_ATTEMPTS = 5;

export class Firestore {
  readonly _baseUrl: string;
  readonly _docsRoot: string;

  constructor(readonly projectId: string) {
    this._docsRoot = `projects/${projectId}/databases/(default)/documents`;
    this._baseUrl = `https://firestore.googleapis.com/v1/${this._docsRoot}`;
  }

  collection(path: string): CollectionReference {
    return new CollectionReference(this, path);
  }

  doc(path: string): DocumentReference {
    return new DocumentReference(this, path);
  }

  batch(): WriteBatch {
    return new WriteBatch(this);
  }

  async _commit(writes: any[], transaction?: string): Promise<any> {
    const body: any = { writes };
    if (transaction) body.transaction = transaction;
    return firestoreFetch(`${this._baseUrl}:commit`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    let lastErr: any;
    let retryTxId: string | undefined;

    for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt++) {
      const beginBody: any = { options: { readWrite: {} } };
      if (retryTxId) beginBody.options.readWrite.retryTransaction = retryTxId;

      const begin = await firestoreFetch(`${this._baseUrl}:beginTransaction`, {
        method: 'POST',
        body: JSON.stringify(beginBody),
      });
      const txId: string = begin.transaction;
      const tx = new Transaction(this, txId);

      let result: T;
      try {
        result = await fn(tx);
      } catch (err) {
        // App-level error (e.g. 'Insufficient balance') — rollback karke rethrow
        await this._rollback(txId);
        throw err;
      }

      try {
        await this._commit(tx._writes, txId);
        return result;
      } catch (err: any) {
        lastErr = err;
        const retriable = err instanceof FirestoreError &&
          (err.code === 'ABORTED' || err.httpStatus === 409);
        if (!retriable) throw err;
        retryTxId = txId;
        // Chhota backoff — contention pe turant dobara mat maro
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error('Transaction failed after retries');
  }

  private async _rollback(txId: string): Promise<void> {
    try {
      await firestoreFetch(`${this._baseUrl}:rollback`, {
        method: 'POST',
        body: JSON.stringify({ transaction: txId }),
      });
    } catch { /* rollback best-effort hai — original error zyada important */ }
  }
}
