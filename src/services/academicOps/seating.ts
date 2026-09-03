import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf } from '../corePeople/scope';
import { requireFields, guardDbConflict } from '../corePeople/students';

const MANAGE = ['super_admin', 'admin', 'principal'] as const;

interface Candidate {
  enrollment_id: string;
  class_id: string;
}
interface Room {
  id: string;
  name: string;
  row_count: number;
  column_count: number;
  capacity: number;
}
interface Seat {
  room_id: string;
  row_no: number;
  column_no: number;
}

/**
 * Lay out seats room by room, row by row. Only the first `capacity` seats of a
 * room are used, so a room can be under-filled deliberately.
 */
function seatsOf(rooms: Room[]): Seat[] {
  const seats: Seat[] = [];
  for (const room of rooms) {
    let used = 0;
    for (let r = 1; r <= room.row_count && used < room.capacity; r++) {
      for (let c = 1; c <= room.column_count && used < room.capacity; c++) {
        seats.push({ room_id: room.id, row_no: r, column_no: c });
        used++;
      }
    }
  }
  return seats;
}

/**
 * Fill the seats so that no two neighbours — left/right or front/back within a
 * room — come from the same class.
 *
 * At each seat the class with the most students still waiting is taken, unless
 * it is the class of the seat to the left or the seat in front; then the next
 * biggest is used. Taking the largest queue first is what stops one class piling
 * up at the end with nowhere legal left to sit. A seat with no legal class is
 * left empty rather than breaking the rule.
 */
export function allocateSeats(
  candidates: Candidate[],
  seats: Seat[],
): { placed: (Seat & { enrollment_id: string })[]; unseated: number } {
  const queues = new Map<string, string[]>();
  for (const c of candidates) {
    if (!queues.has(c.class_id)) queues.set(c.class_id, []);
    queues.get(c.class_id)!.push(c.enrollment_id);
  }

  const taken = new Map<string, string>(); // "room|row|col" -> class_id
  const key = (roomId: string, row: number, col: number) => `${roomId}|${row}|${col}`;
  const placed: (Seat & { enrollment_id: string })[] = [];

  for (const seat of seats) {
    const blocked = new Set(
      [
        taken.get(key(seat.room_id, seat.row_no, seat.column_no - 1)), // left
        taken.get(key(seat.room_id, seat.row_no - 1, seat.column_no)), // in front
      ].filter(Boolean) as string[],
    );

    let bestClass: string | undefined;
    let bestRemaining = 0;
    for (const [classId, queue] of queues) {
      if (!queue.length || blocked.has(classId)) continue;
      if (queue.length > bestRemaining) {
        bestRemaining = queue.length;
        bestClass = classId;
      }
    }
    if (!bestClass) continue; // leave the seat empty rather than seat neighbours together

    const enrollmentId = queues.get(bestClass)!.shift()!;
    taken.set(key(seat.room_id, seat.row_no, seat.column_no), bestClass);
    placed.push({ ...seat, enrollment_id: enrollmentId });
  }

  let unseated = 0;
  for (const queue of queues.values()) unseated += queue.length;
  return { placed, unseated };
}

/** Base doc §5.3 — exam rooms and seating plans. */
export function seatingRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /exam-rooms
  r.get('/exam-rooms', requireRole(...MANAGE), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT id, name, row_count AS rows, column_count AS columns, capacity, is_active
         FROM exam_rooms ORDER BY name`,
    );
    res.json(ok(rows));
  }));

  // POST /exam-rooms — capacity defaults to the whole grid.
  r.post('/exam-rooms', requireRole(...MANAGE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'rows', 'columns']);
    const rowCount = Number(b.rows);
    const columnCount = Number(b.columns);
    const capacity = b.capacity === undefined || b.capacity === null
      ? rowCount * columnCount
      : Number(b.capacity);

    for (const [field, value] of [['rows', rowCount], ['columns', columnCount], ['capacity', capacity]] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw AppError.validation([{ field, message: 'must be a whole number of at least 1' }]);
      }
    }
    if (capacity > rowCount * columnCount) {
      throw AppError.validation([{
        field: 'capacity',
        message: `cannot exceed the grid — ${rowCount} x ${columnCount} is ${rowCount * columnCount} seats`,
      }]);
    }

    const { rows } = await guardDbConflict(
      () => pools.query(
        ctxOf(req),
        `INSERT INTO exam_rooms (name, row_count, column_count, capacity)
         VALUES ($1,$2,$3,$4)
         RETURNING id, name, row_count AS rows, column_count AS columns, capacity, is_active`,
        [b.name, rowCount, columnCount, capacity],
      ),
      'A room with that name already exists',
    );
    res.status(201).json(ok(rows[0]));
  }));

  // POST /exams/:examId/seating/generate
  // Body: { section_ids: [...], room_ids?: [...] }
  r.post('/exams/:examId/seating/generate', requireRole(...MANAGE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body ?? {};
    const sectionIds: string[] = Array.isArray(b.section_ids) ? b.section_ids : [];
    if (!sectionIds.length) {
      throw AppError.validation([{ field: 'section_ids', message: 'must be a non-empty array' }]);
    }

    const exam = await pools.query(ctx, `SELECT id, name FROM exams WHERE id = $1`, [req.params.examId]);
    if (!exam.rows.length) throw AppError.notFound('Exam');

    const roomIds: string[] | null = Array.isArray(b.room_ids) && b.room_ids.length ? b.room_ids : null;
    const rooms = (await pools.query<Room>(
      ctx,
      `SELECT id, name, row_count, column_count, capacity
         FROM exam_rooms
        WHERE is_active AND ($1::uuid[] IS NULL OR id = ANY($1))
        ORDER BY name`,
      [roomIds],
    )).rows;
    if (!rooms.length) {
      throw AppError.validation([{ field: 'room_ids', message: 'no active exam rooms to seat students in' }]);
    }

    const candidates = (await pools.query<Candidate>(
      ctx,
      `SELECT e.id AS enrollment_id, sec.class_id
         FROM student_enrollments e
         JOIN sections sec ON sec.id = e.section_id
         JOIN students s ON s.id = e.student_id
        WHERE e.section_id = ANY($1) AND e.status = 'active'
          AND s.deleted_at IS NULL AND s.is_active
        ORDER BY sec.class_id, e.id`,
      [sectionIds],
    )).rows;
    if (!candidates.length) {
      throw AppError.validation([{ field: 'section_ids', message: 'those sections have no active students' }]);
    }

    const seats = seatsOf(rooms);
    if (candidates.length > seats.length) {
      // Say what is missing, not just that it failed.
      throw new AppError(
        'CONFLICT',
        `Not enough seats: ${candidates.length} students need seating, ` +
          `${rooms.length} room(s) provide ${seats.length}. ` +
          `Add ${candidates.length - seats.length} more seat(s).`,
        [
          { field: 'students', message: String(candidates.length) },
          { field: 'seats_available', message: String(seats.length) },
          { field: 'short_by', message: String(candidates.length - seats.length) },
        ],
      );
    }

    const { placed, unseated } = allocateSeats(candidates, seats);
    if (unseated > 0) {
      // Enough seats existed, but not enough that keep classes apart.
      throw new AppError(
        'CONFLICT',
        `Could not seat ${unseated} student(s) without putting classmates next to ` +
          `each other. Add another room, or spread these sections across more exams.`,
        [
          { field: 'students', message: String(candidates.length) },
          { field: 'seats_available', message: String(seats.length) },
          { field: 'unseated', message: String(unseated) },
        ],
      );
    }

    await pools.withTransaction(ctx, async (client) => {
      // Regenerating replaces the plan outright, so a second run cannot leave
      // yesterday's seats behind or double-book anyone.
      await client.query(`DELETE FROM exam_seat_allocations WHERE exam_id = $1`, [req.params.examId]);
      for (const p of placed) {
        await client.query(
          `INSERT INTO exam_seat_allocations (exam_id, room_id, enrollment_id, row_no, column_no)
           VALUES ($1,$2,$3,$4,$5)`,
          [req.params.examId, p.room_id, p.enrollment_id, p.row_no, p.column_no],
        );
      }
    });

    res.status(201).json(ok({
      exam_id: req.params.examId,
      students_seated: placed.length,
      seats_available: seats.length,
      rooms_used: new Set(placed.map((p) => p.room_id)).size,
    }));
  }));

  // GET /exams/:examId/seating — room by room, with the grid and every name.
  r.get('/exams/:examId/seating', requireRole(...MANAGE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const exam = await pools.query(ctx, `SELECT id, name FROM exams WHERE id = $1`, [req.params.examId]);
    if (!exam.rows.length) throw AppError.notFound('Exam');

    const { rows } = await pools.query<{
      room_id: string; room: string; rows: number; columns: number;
      row_no: number; column_no: number; student_id: string; student_name: string;
      admission_number: string; class_name: string | null; section_name: string | null;
    }>(
      ctx,
      `SELECT rm.id AS room_id, rm.name AS room,
              rm.row_count AS rows, rm.column_count AS columns,
              a.row_no, a.column_no,
              s.id AS student_id,
              TRIM(s.first_name || ' ' || s.last_name) AS student_name,
              s.admission_number,
              c.name   AS class_name,
              sec.name AS section_name
         FROM exam_seat_allocations a
         JOIN exam_rooms rm ON rm.id = a.room_id
         JOIN student_enrollments e ON e.id = a.enrollment_id
         JOIN students s ON s.id = e.student_id
         LEFT JOIN sections sec ON sec.id = e.section_id
         LEFT JOIN classes c ON c.id = sec.class_id
        WHERE a.exam_id = $1
        ORDER BY rm.name, a.row_no, a.column_no`,
      [req.params.examId],
    );

    const byRoom = new Map<string, {
      room_id: string; room: string; rows: number; columns: number; seats: unknown[];
    }>();
    for (const row of rows) {
      if (!byRoom.has(row.room_id)) {
        byRoom.set(row.room_id, {
          room_id: row.room_id, room: row.room, rows: row.rows, columns: row.columns, seats: [],
        });
      }
      byRoom.get(row.room_id)!.seats.push({
        row: row.row_no,
        column: row.column_no,
        student_id: row.student_id,
        student_name: row.student_name,
        admission_number: row.admission_number,
        class_name: row.class_name,
        section_name: row.section_name,
      });
    }
    res.json(ok({ exam: exam.rows[0], rooms: [...byRoom.values()] }));
  }));

  return r;
}
