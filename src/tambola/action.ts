// src/tambola/action.ts — Tambola (Housie) game handler
//
// Rules: 3×9 ticket, 15 numbers, har row mein 5. Numbers 1-90 server se har
// callIntervalSecs mein auto-call hote hain (client-driven tick, server verify —
// wahi pattern jo realludo timeout / joker-pair auto-discard use karta hai).
// Marking auto hai (client calledNumbers se render karta hai), sirf CLAIM user
// dabata hai. Sara validation server pe — ticket private subcollection mein hai.
//
// Prizes (prizePool ka, 10% commission ke baad):
//   earlyFive 15% | topLine 15% | middleLine 15% | bottomLine 15% | fullHouse 40%

import type { VercelRequest, VercelResponse } from '../lib/vercelShim';
import { randomInt }                          from '../lib/nodeCompat';
import { FieldValue }                         from '../lib/firestoreRest';
import { db }                                 from '../lib/firebaseAdmin';
import { internalWalletTransaction }          from '../lib/walletInternal';
import { verifyToken, sanitize, setCors }     from '../lib/middleware';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const TAMBOLA_TABLES   = 'tambolaTables';
const TAMBOLA_GAMES    = 'tambolaGames';
const PAYOUT_RETRY_COL = 'payoutRetryQueue';

const MIN_PLAYERS      = 2;
const MAX_PLAYERS      = 10;
const CALL_INTERVAL    = 5;    // seconds — client countdown isi se anchor hota hai
const COMMISSION_RATE  = 0.10;
const FINALIZE_GRACE   = 30_000; // ms — 90 numbers ke baad claims ke liye grace

const PRIZE_KEYS = ['earlyFive', 'topLine', 'middleLine', 'bottomLine', 'fullHouse'] as const;
type PrizeKey = typeof PRIZE_KEYS[number];

// Pool (after commission) ka share per prize
const PRIZE_SHARE: Record<PrizeKey, number> = {
  earlyFive:  0.15,
  topLine:    0.15,
  middleLine: 0.15,
  bottomLine: 0.15,
  fullHouse:  0.40,
};

// ─────────────────────────────────────────────────────────────────────────────
// Ticket generation — proper tambola rules:
//   3 rows × 9 cols; har row exactly 5 numbers (total 15);
//   col0 = 1-9, col1 = 10-19, ... col8 = 80-90; har column 1-3 numbers,
//   column ke numbers upar se niche ascending.
// Grid representation: rows[3][9], khali cell = 0.
// ─────────────────────────────────────────────────────────────────────────────
const COL_RANGES: Array<[number, number]> = [
  [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
  [50, 59], [60, 69], [70, 79], [80, 90],
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function generateTicket(): number[][] {
  // 1) Har column ko 1 number, bache 6 randomly (col max 3)
  const colCounts = new Array(9).fill(1);
  let remaining = 6;
  while (remaining > 0) {
    const c = randomInt(0, 9);
    if (colCounts[c] < 3) { colCounts[c]++; remaining--; }
  }

  // 2) Columns ko rows mein baanto — greedy: sabse zyada count wala column
  //    pehle, hamesha sabse zyada capacity wali rows mein. Har row ki capacity
  //    5 hai (3×5 = 15 = sum of colCounts), isliye yeh hamesha feasible hai.
  const rowCap = [5, 5, 5];
  const colRows: number[][] = Array.from({ length: 9 }, () => []);
  const colOrder = [...Array(9).keys()].sort((a, b) => colCounts[b] - colCounts[a]);
  for (const c of colOrder) {
    const rows = [0, 1, 2]
      .sort((a, b) => rowCap[b] - rowCap[a] || (randomInt(0, 2) === 0 ? -1 : 1))
      .slice(0, colCounts[c])
      .sort((a, b) => a - b);
    for (const r of rows) rowCap[r]--;
    colRows[c] = rows;
  }

  // 3) Har column ke liye numbers chuno, ascending order mein upar se niche
  const grid: number[][] = [
    new Array(9).fill(0), new Array(9).fill(0), new Array(9).fill(0),
  ];
  for (let c = 0; c < 9; c++) {
    const [lo, hi] = COL_RANGES[c];
    const pool = [];
    for (let n = lo; n <= hi; n++) pool.push(n);
    const nums = shuffle(pool).slice(0, colCounts[c]).sort((a, b) => a - b);
    colRows[c].forEach((r, i) => { grid[r][c] = nums[i]; });
  }
  return grid;
}

function ticketNumbers(grid: number[][]): number[] {
  return grid.flat().filter((n) => n > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim validation — server-side, calledNumbers ke against
// ─────────────────────────────────────────────────────────────────────────────
function isClaimValid(grid: number[][], claimType: PrizeKey, called: Set<number>): boolean {
  const rowDone = (r: number) => grid[r].filter((n) => n > 0).every((n) => called.has(n));
  switch (claimType) {
    case 'earlyFive': {
      const marked = ticketNumbers(grid).filter((n) => called.has(n));
      return marked.length >= 5;
    }
    case 'topLine':    return rowDone(0);
    case 'middleLine': return rowDone(1);
    case 'bottomLine': return rowDone(2);
    case 'fullHouse':  return ticketNumbers(grid).every((n) => called.has(n));
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Prize amounts — pool (after commission) ke shares, floor per prize
// ─────────────────────────────────────────────────────────────────────────────
function prizeAmounts(prizePool: number): Record<PrizeKey, number> {
  const pool = prizePool - Math.floor(prizePool * COMMISSION_RATE);
  const out = {} as Record<PrizeKey, number>;
  for (const k of PRIZE_KEYS) out[k] = Math.floor(pool * PRIZE_SHARE[k]);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — realludo pattern: game doc delete, table reset, round bump
// (round idempotency keys ko fresh rakhta hai jab table reuse hoti hai)
// ─────────────────────────────────────────────────────────────────────────────
const cleanupTable = async (tableId: string): Promise<void> => {
  const tableRef = db.collection(TAMBOLA_TABLES).doc(tableId);
  const gameRef  = db.collection(TAMBOLA_GAMES).doc(tableId);

  // Private subcollection docs pehle delete karo (players + _server)
  try {
    const gameSnap = await gameRef.get();
    if (gameSnap.exists) {
      const players = (gameSnap.data()!.players || []) as string[];
      const batch = db.batch();
      for (const p of players) batch.delete(gameRef.collection('private').doc(p));
      batch.delete(gameRef.collection('private').doc('_server'));
      await batch.commit();
    }
    await gameRef.delete();
  } catch (err) {
    console.error(`[Tambola] cleanupTable: game doc delete failed for ${tableId}:`, err);
  }

  try {
    await tableRef.update({
      status:        'waiting',
      players:       [],
      playerNames:   {},
      playerAvatars: {},
      prizePool:     0,
      round:         FieldValue.increment(1),
      updatedAt:     FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[Tambola] cleanupTable: table reset failed for ${tableId}:`, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Prize payout — claim-first pattern (realludo processPayout jaisa):
// prize flag transaction mein claim hota hai (caller karta hai), yahan sirf
// wallet ADD + failure pe retry queue.
// ─────────────────────────────────────────────────────────────────────────────
async function payPrize(
  tableId: string, round: number, uid: string, claimType: PrizeKey, amount: number,
): Promise<void> {
  const idempotencyKey = `tambola_${claimType}_${tableId}_r${round}_${uid}`;
  try {
    await internalWalletTransaction({
      action:         'ADD',
      uid,
      amount,
      type:           'GAME_WIN',
      game:           'Tambola',
      description:    `Tambola ${claimType} ₹${amount} - Table ${tableId}`,
      balanceType:    'winningBalance',
      idempotencyKey,
    });
  } catch (err) {
    console.error(`CRITICAL: Tambola payout failed ${tableId}/${claimType}:`, err);
    await db.collection(PAYOUT_RETRY_COL).add({
      kind: 'payout', game: 'Tambola',
      tableId, round, winnerId: uid, claimType, amount,
      idempotencyKeys: [idempotencyKey],
      error:     err instanceof Error ? err.message : String(err),
      createdAt: FieldValue.serverTimestamp(),
      attempts:  1, resolved: false,
    }).catch(() => {});
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { type, ...body } = req.body ?? {};
  if (!type) { res.status(400).json({ ok: false, error: 'type required' }); return; }

  let uid = '';
  try {
    uid = await verifyToken(req);
  } catch (e: any) {
    return res.status(e.status || 401).json({ ok: false, error: e.message });
  }

  const { tableId } = body;

  try {
    switch (type) {
      // ── GET TABLES ────────────────────────────────────────────────────────
      case 'getTables': {
        const snap = await db.collection(TAMBOLA_TABLES)
          .where('status', 'in', ['waiting', 'playing'])
          .orderBy('entryFee', 'asc')
          .get();
        const tables = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return res.status(200).json({ ok: true, tables });
      }

      // ── JOIN ──────────────────────────────────────────────────────────────
      case 'join': {
        sanitize(body, ['tableId', 'name']);
        const { name, avatar } = body;
        const safeAvatar = typeof avatar === 'string' ? avatar.slice(0, 500) : '';

        const tableRef  = db.collection(TAMBOLA_TABLES).doc(tableId);
        const tableSnap = await tableRef.get();
        if (!tableSnap.exists) return res.status(404).json({ ok: false, error: 'Table not found' });

        const table    = tableSnap.data()!;
        const players  = (table.players  || []) as string[];
        const entryFee = (table.entryFee || 0) as number;
        const round    = (table.round    || 0) as number;

        if (table.status !== 'waiting')
          return res.status(400).json({ ok: false, error: 'Game already started' });
        if (players.includes(uid))
          return res.status(200).json({ ok: true, alreadyJoined: true });
        if (players.length >= MAX_PLAYERS)
          return res.status(400).json({ ok: false, error: 'Table is full' });

        try {
          await internalWalletTransaction({
            action:         'DEDUCT',
            uid,
            amount:         entryFee,
            type:           'GAME_ENTRY',
            game:           'Tambola',
            description:    `Tambola Entry ₹${entryFee} - Table ${tableId}`,
            idempotencyKey: `tambola_join_${tableId}_r${round}_${uid}`,
          });
        } catch (walletErr: any) {
          return res.status(402).json({ ok: false, error: walletErr.message || 'Insufficient balance' });
        }

        try {
          await db.runTransaction(async (tx) => {
            const fresh = await tx.get(tableRef);
            const cur   = fresh.data()!;
            if ((cur.players || []).includes(uid))         throw new Error('ALREADY_JOINED');
            if (cur.status !== 'waiting')                  throw new Error('Game already started');
            if ((cur.round || 0) !== round)                throw new Error('Table was reset, please rejoin');
            if ((cur.players || []).length >= MAX_PLAYERS) throw new Error('TABLE_FULL');

            tx.update(tableRef, {
              players:                  FieldValue.arrayUnion(uid),
              [`playerNames.${uid}`]:   name,
              [`playerAvatars.${uid}`]: safeAvatar,
              prizePool:                FieldValue.increment(entryFee),
              updatedAt:                FieldValue.serverTimestamp(),
            });
          });
        } catch (txErr: any) {
          if (txErr.message === 'ALREADY_JOINED')
            return res.status(200).json({ ok: true, alreadyJoined: true });

          await internalWalletTransaction({
            action:         'ADD',
            uid,
            amount:         entryFee,
            type:           'REFUND',
            game:           'Tambola',
            description:    `Tambola Join Refund ₹${entryFee} - Table ${tableId}`,
            balanceType:    'depositBalance',
            idempotencyKey: `tambola_join_refund_${tableId}_r${round}_${uid}`,
          }).catch(console.error);

          return res.status(400).json({
            ok: false,
            error: txErr.message === 'TABLE_FULL' ? 'Table is full' : txErr.message,
          });
        }

        return res.status(200).json({ ok: true, alreadyJoined: false, entryFee });
      }

      // ── LEAVE (sirf waiting state — refund ke saath) ──────────────────────
      case 'leave': {
        sanitize(body, ['tableId']);
        const tableRef  = db.collection(TAMBOLA_TABLES).doc(tableId);
        const tableSnap = await tableRef.get();
        if (!tableSnap.exists) return res.status(404).json({ ok: false, error: 'Table not found' });

        const table = tableSnap.data()!;
        const round = (table.round || 0) as number;
        const entryFee = (table.entryFee || 0) as number;

        if (table.status !== 'waiting')
          return res.status(400).json({ ok: false, error: 'Game already started — cannot leave' });
        if (!(table.players || []).includes(uid))
          return res.status(400).json({ ok: false, error: 'Not at this table' });

        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(tableRef);
          const cur   = fresh.data()!;
          if (cur.status !== 'waiting') throw new Error('Game already started — cannot leave');
          if (!(cur.players || []).includes(uid)) throw new Error('Not at this table');
          tx.update(tableRef, {
            players:                  FieldValue.arrayRemove(uid),
            [`playerNames.${uid}`]:   FieldValue.delete(),
            [`playerAvatars.${uid}`]: FieldValue.delete(),
            prizePool:                FieldValue.increment(-entryFee),
            updatedAt:                FieldValue.serverTimestamp(),
          });
        });

        await internalWalletTransaction({
          action:         'ADD',
          uid,
          amount:         entryFee,
          type:           'REFUND',
          game:           'Tambola',
          description:    `Tambola Leave Refund ₹${entryFee} - Table ${tableId}`,
          balanceType:    'depositBalance',
          idempotencyKey: `tambola_leave_${tableId}_r${round}_${uid}`,
        });

        return res.status(200).json({ ok: true });
      }

      // ── START — 2+ players pe koi bhi client trigger kare (race-safe) ─────
      case 'start': {
        sanitize(body, ['tableId']);
        const tableRef = db.collection(TAMBOLA_TABLES).doc(tableId);
        const gameRef  = db.collection(TAMBOLA_GAMES).doc(tableId);

        // Transaction: table ko 'playing' claim karo — sirf ek hi start jeete
        let claimed: any = null;
        try {
          claimed = await db.runTransaction(async (tx) => {
            const snap = await tx.get(tableRef);
            if (!snap.exists) throw new Error('Table not found');
            const t = snap.data()!;
            if (t.status !== 'waiting') return null; // already started
            if (!(t.players || []).includes(uid)) throw new Error('Not at this table');
            if ((t.players || []).length < MIN_PLAYERS)
              throw new Error(`Need at least ${MIN_PLAYERS} players`);
            tx.update(tableRef, { status: 'playing', updatedAt: FieldValue.serverTimestamp() });
            return t;
          });
        } catch (e: any) {
          return res.status(400).json({ ok: false, error: e.message });
        }
        if (!claimed) return res.status(200).json({ ok: true, alreadyStarted: true });

        const players   = claimed.players as string[];
        const round     = (claimed.round || 0) as number;
        const prizePool = (claimed.prizePool || 0) as number;
        const prizes    = prizeAmounts(prizePool);

        // Shuffled 1-90 sequence — sirf _server doc mein (clients ko nahi dikhta)
        const seq = shuffle(Array.from({ length: 90 }, (_, i) => i + 1));

        const batch = db.batch();
        // Har player ka ticket private doc mein
        for (const p of players) {
          const grid = generateTicket();
          batch.set(gameRef.collection('private').doc(p), {
            uid: p, grid, createdAt: FieldValue.serverTimestamp(),
          });
        }
        batch.set(gameRef.collection('private').doc('_server'), { seq });
        // Public game doc
        batch.set(gameRef, {
          tableId,
          status:           'playing',
          players,
          playerNames:      claimed.playerNames   || {},
          playerAvatars:    claimed.playerAvatars || {},
          calledNumbers:    [],
          currentNumber:    null,
          nextCallAt:       Date.now() + CALL_INTERVAL * 1000,
          callIntervalSecs: CALL_INTERVAL,
          prizes: {
            earlyFive:  { claimedBy: null, name: null, amount: prizes.earlyFive },
            topLine:    { claimedBy: null, name: null, amount: prizes.topLine },
            middleLine: { claimedBy: null, name: null, amount: prizes.middleLine },
            bottomLine: { claimedBy: null, name: null, amount: prizes.bottomLine },
            fullHouse:  { claimedBy: null, name: null, amount: prizes.fullHouse },
          },
          prizePool,
          entryFee:  claimed.entryFee || 0,
          round,
          startedAt: Date.now(),
          finishedAt: null,
          payoutDone: false,
        });
        await batch.commit();

        return res.status(200).json({ ok: true, started: true });
      }

      // ── CALL — agla number (client-driven tick, server verify) ────────────
      case 'call': {
        sanitize(body, ['tableId']);
        const gameRef = db.collection(TAMBOLA_GAMES).doc(tableId);

        const result = await db.runTransaction(async (tx) => {
          const snap = await tx.get(gameRef);
          if (!snap.exists) return { skipped: true, reason: 'Game not found' };
          const g = snap.data()!;
          if (g.status !== 'playing') return { skipped: true, reason: 'Game not active' };
          if (!(g.players || []).includes(uid)) return { skipped: true, reason: 'Not in game' };

          const called = (g.calledNumbers || []) as number[];

          // 90 numbers ho gaye — grace ke baad game finalize
          if (called.length >= 90) {
            if (Date.now() >= (g.nextCallAt || 0) + FINALIZE_GRACE) {
              tx.update(gameRef, { status: 'finished', finishedAt: Date.now() });
              return { finished: true };
            }
            return { skipped: true, reason: 'All numbers called' };
          }

          // Abhi time nahi hua (2s clock-skew grace)
          if (Date.now() < (g.nextCallAt || 0) - 2000)
            return { skipped: true, reason: 'Not time yet' };

          const srvSnap = await tx.get(gameRef.collection('private').doc('_server'));
          const seq = (srvSnap.data()?.seq || []) as number[];
          const next = seq[called.length];
          if (next === undefined) return { skipped: true, reason: 'Sequence exhausted' };

          tx.update(gameRef, {
            calledNumbers: FieldValue.arrayUnion(next),
            currentNumber: next,
            nextCallAt:    Date.now() + CALL_INTERVAL * 1000,
          });
          return { called: next };
        });

        return res.status(200).json({ ok: true, ...result });
      }

      // ── CLAIM — pattern claim (server validate, claim-first payout) ───────
      case 'claim': {
        sanitize(body, ['tableId', 'claimType']);
        const claimType = body.claimType as PrizeKey;
        if (!PRIZE_KEYS.includes(claimType))
          return res.status(400).json({ ok: false, error: 'Invalid claim type' });

        const gameRef = db.collection(TAMBOLA_GAMES).doc(tableId);

        // Transaction: validate + prize flag claim — paisa transaction ke BAAD
        // (claim-first pattern: do racing claims kabhi dono pay nahi honge)
        let outcome: { win?: boolean; amount?: number; round?: number; allClaimed?: boolean; error?: string };
        try {
          outcome = await db.runTransaction(async (tx) => {
            const snap = await tx.get(gameRef);
            if (!snap.exists) return { error: 'Game not found' };
            const g = snap.data()!;
            if (g.status !== 'playing') return { error: 'Game not active' };
            if (!(g.players || []).includes(uid)) return { error: 'Not in game' };

            const prize = g.prizes?.[claimType];
            if (!prize) return { error: 'Invalid prize' };
            if (prize.claimedBy) return { error: 'Already claimed' };

            const ticketSnap = await tx.get(gameRef.collection('private').doc(uid));
            if (!ticketSnap.exists) return { error: 'Ticket not found' };
            const grid = ticketSnap.data()!.grid as number[][];

            const called = new Set<number>((g.calledNumbers || []) as number[]);
            if (!isClaimValid(grid, claimType, called))
              return { error: 'Invalid claim — pattern not complete' };

            const name = g.playerNames?.[uid] || 'Player';
            const update: Record<string, any> = {
              [`prizes.${claimType}.claimedBy`]: uid,
              [`prizes.${claimType}.name`]:      name,
            };

            // Sab prizes claimed? (yeh claim included)
            const allClaimed = PRIZE_KEYS.every(
              (k) => k === claimType || g.prizes[k]?.claimedBy,
            );
            if (allClaimed) {
              update.status     = 'finished';
              update.finishedAt = Date.now();
            }
            tx.update(gameRef, update);

            return { win: true, amount: prize.amount, round: g.round || 0, allClaimed };
          });
        } catch (e: any) {
          return res.status(400).json({ ok: false, error: e.message });
        }

        if (outcome.error) return res.status(400).json({ ok: false, error: outcome.error });

        // Wallet payout — flag already claimed hai, fail hua to retry queue
        await payPrize(tableId, outcome.round!, uid, claimType, outcome.amount!)
          .catch(() => { /* queued for retry — claim khada rahta hai */ });

        // Game khatam — table reuse ke liye reset (fire-and-forget nahi:
        // Workers mein waitUntil nahi use kar rahe, await hi karo)
        if (outcome.allClaimed) await cleanupTable(tableId).catch(console.error);

        return res.status(200).json({
          ok: true, win: true, claimType, amount: outcome.amount, allClaimed: !!outcome.allClaimed,
        });
      }

      default:
        return res.status(404).json({ ok: false, error: `Unknown type: ${type}` });
    }
  } catch (err: any) {
    console.error(`[tambola/${type}]`, err);
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || 'Internal server error' });
  }
}
