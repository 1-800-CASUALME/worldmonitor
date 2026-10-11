/**
 * Reader error reports (#9093). A reader says a label or story is wrong; the
 * report is stored for an operator and never applied automatically. Accepting
 * one publishes only the operator's public note to the label log; the
 * reader's message and contact stay private.
 *
 * Storage: one JSON record per report (90-day TTL), a pending queue and a
 * reviewed list as sorted sets. The pending queue is bounded: when it is full,
 * new reports are refused rather than evicting older ones, so spam can never
 * push a real report out unseen.
 */
import { runRedisPipeline, type RedisCommandResult } from './redis';
import { correctionEntry, labelChangeCommands } from './label-history';
import { timingSafeEqual } from './internal-auth';

export const ERROR_REPORT_KEY = (id: string) => `trust:report:v1:${id}`;
export const PENDING_REPORTS_KEY = 'trust:reports:pending:v1';
export const REVIEWED_REPORTS_KEY = 'trust:reports:reviewed:v1';
export const PENDING_REPORTS_MAX = 1000;
const REVIEWED_REPORTS_MAX = 500;
const LIST_LIMIT = 200;
export const ERROR_REPORT_TTL_S = 90 * 24 * 60 * 60;

/** Header carrying the operator secret (TRUST_REVIEW_SECRET). */
export const TRUST_REVIEW_HEADER = 'x-trust-review-key';

export type ErrorReportStatus = 'pending' | 'accepted' | 'rejected';

export interface StoredErrorReport {
  id: string;
  status: ErrorReportStatus;
  message: string;
  storyId: string;
  url: string;
  contact: string;
  createdAt: number;
  reviewedAt: number;
  publicNote: string;
}

/** True only when TRUST_REVIEW_SECRET is set and the request carries it. Unset → nobody is an operator. */
export async function isTrustReviewer(request: Request): Promise<boolean> {
  const secret = process.env.TRUST_REVIEW_SECRET;
  if (!secret) return false;
  return timingSafeEqual(request.headers.get(TRUST_REVIEW_HEADER) ?? '', secret);
}

function parseReport(raw: unknown): StoredErrorReport | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredErrorReport>;
    if (typeof value.id !== 'string' || typeof value.message !== 'string') return null;
    if (value.status !== 'pending' && value.status !== 'accepted' && value.status !== 'rejected') return null;
    return {
      id: value.id,
      status: value.status,
      message: value.message,
      storyId: typeof value.storyId === 'string' ? value.storyId : '',
      url: typeof value.url === 'string' ? value.url : '',
      contact: typeof value.contact === 'string' ? value.contact : '',
      createdAt: Number(value.createdAt) || 0,
      reviewedAt: Number(value.reviewedAt) || 0,
      publicNote: typeof value.publicNote === 'string' ? value.publicNote : '',
    };
  } catch {
    return null;
  }
}

const confirmed = (results: RedisCommandResult[], count: number) =>
  results.length === count && results.every((result) => !result.error);

/** 'received', 'queue-full', or 'unavailable' when Redis could not confirm the write. */
export async function storeErrorReport(report: StoredErrorReport): Promise<'received' | 'queue-full' | 'unavailable'> {
  const [size] = await runRedisPipeline([['ZCARD', PENDING_REPORTS_KEY]]);
  if (!size || size.error || typeof size.result !== 'number') return 'unavailable';
  if (size.result >= PENDING_REPORTS_MAX) return 'queue-full';
  const commands = [
    ['SET', ERROR_REPORT_KEY(report.id), JSON.stringify(report), 'NX', 'EX', ERROR_REPORT_TTL_S],
    ['ZADD', PENDING_REPORTS_KEY, report.createdAt, report.id],
  ];
  return confirmed(await runRedisPipeline(commands), commands.length) ? 'received' : 'unavailable';
}

/** Pending reports oldest first, or reviewed reports newest first; null when Redis is unreadable. */
export async function listErrorReports(status: 'pending' | 'reviewed'): Promise<StoredErrorReport[] | null> {
  const [ids] = await runRedisPipeline([
    status === 'pending'
      ? ['ZRANGE', PENDING_REPORTS_KEY, 0, LIST_LIMIT - 1]
      : ['ZREVRANGE', REVIEWED_REPORTS_KEY, 0, LIST_LIMIT - 1],
  ]);
  if (!ids || ids.error || !Array.isArray(ids.result)) return null;
  const keys = ids.result.filter((id): id is string => typeof id === 'string');
  if (keys.length === 0) return [];
  const records = await runRedisPipeline(keys.map((id) => ['GET', ERROR_REPORT_KEY(id)]));
  if (records.length !== keys.length) return null;
  // A record past its TTL is gone; its id is skipped rather than shown empty.
  return records.map((record) => parseReport(record.result)).filter((r): r is StoredErrorReport => r !== null);
}

export async function readErrorReport(id: string): Promise<StoredErrorReport | null | 'unavailable'> {
  const [record] = await runRedisPipeline([['GET', ERROR_REPORT_KEY(id)]]);
  if (!record || record.error) return 'unavailable';
  return parseReport(record.result);
}

/**
 * Record a decision. Accepting appends the public note to the label log with
 * trigger 'report'. Returns the reviewed report, or 'unavailable' when the
 * write was not confirmed.
 */
export async function reviewErrorReport(
  report: StoredErrorReport,
  decision: 'accepted' | 'rejected',
  publicNote: string,
  now: number,
): Promise<StoredErrorReport | 'unavailable'> {
  const reviewed: StoredErrorReport = { ...report, status: decision, reviewedAt: now, publicNote };
  const commands = [
    ['SET', ERROR_REPORT_KEY(report.id), JSON.stringify(reviewed), 'XX', 'EX', ERROR_REPORT_TTL_S],
    ['ZREM', PENDING_REPORTS_KEY, report.id],
    ['ZADD', REVIEWED_REPORTS_KEY, now, report.id],
    ['ZREMRANGEBYRANK', REVIEWED_REPORTS_KEY, 0, -(REVIEWED_REPORTS_MAX + 1)],
    ...(decision === 'accepted' ? labelChangeCommands(correctionEntry(report, publicNote, now)) : []),
  ];
  return confirmed(await runRedisPipeline(commands), commands.length) ? reviewed : 'unavailable';
}
