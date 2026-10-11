/**
 * Item-level label history (#9093).
 *
 * WorldMonitor labels each story with how widely it is covered
 * (assessCorroboration). When that label moves between single-publisher and
 * corroborated, the change is recorded here, in the open, with the publishers
 * behind it. The log is append-only and bounded: entries are kept for
 * LABEL_HISTORY_RETENTION_MS and readers drop anything older.
 *
 * Only these two states are logged. tier4-only and unknown depend on which
 * feed labels a cycle happened to keep, so logging them would mostly record
 * churn rather than a change in coverage.
 *
 * The label describes coverage, not accuracy: a change to "corroborated" means
 * more publishers carry the story, not that it was confirmed.
 */
import {
  assessCorroboration,
  evidenceFromCluster,
  publisherRoster,
  type Corroboration,
} from './corroboration';
import { runRedisPipeline, type RedisPipelineCommand } from './redis';

export const LABEL_HISTORY_STATES = ['single-publisher', 'corroborated'] as const;
export type LabelHistoryState = (typeof LABEL_HISTORY_STATES)[number];

/** Seven days, the retention the owner set for #9093. */
export const LABEL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_S = LABEL_HISTORY_RETENTION_MS / 1000;

/** Newest-first log of every recorded change. */
export const LABEL_CHANGES_KEY = 'trust:label-changes:v1';
/** Newest-first changes for one story. */
export const STORY_LABEL_HISTORY_KEY = (storyId: string) => `trust:label-history:v1:${storyId}`;
/** One recorder per story transition: concurrent digest builds must not log it twice. */
const LABEL_CHANGE_GUARD_KEY = (storyId: string, previous: string, next: string) =>
  `trust:label-change-guard:v1:${storyId}:${previous}:${next}`;
const LABEL_CHANGE_GUARD_TTL_S = 15 * 60;

export const LABEL_CHANGES_MAX = 500;
export const STORY_LABEL_HISTORY_MAX = 20;
/** Publishers listed per entry; the count is always complete. */
const ENTRY_PUBLISHERS_MAX = 12;

/** Story-track hash field holding the last recorded label, as `state|publishers`. */
export const STORY_LABEL_FIELD = 'corrState';

export interface StoryLabel {
  readonly state: Corroboration['state'];
  readonly publishers: number | null;
  readonly roster: readonly { readonly name: string; readonly tier: number | null }[];
}

export interface LabelChangePublisher {
  readonly name: string;
  /** Declared source tier 1-4; null when no label declares one. */
  readonly tier: number | null;
}

export interface LabelChange {
  readonly storyId: string;
  readonly field: 'corroboration';
  readonly previous: LabelHistoryState;
  readonly next: LabelHistoryState;
  readonly previousPublishers: number;
  readonly nextPublishers: number;
  /** Epoch ms. */
  readonly at: number;
  /** 'digest' for automatic changes; accepted reports use 'report' (#9093 intake). */
  readonly trigger: 'digest' | 'report';
  readonly reason: string;
  /** Publishers behind the new label, tier first. */
  readonly sources: readonly LabelChangePublisher[];
  readonly title: string;
  readonly link: string;
  /** The story's CRED score (0-100) when the change was recorded, if known. */
  readonly credibilityScore: number | null;
}

/** The label a story carries this cycle, from the items the digest kept for it. */
export function storyLabel(
  items: readonly { readonly source: string; readonly corroborationCount?: number }[],
): StoryLabel {
  const evidence = evidenceFromCluster({ allItems: items });
  const corroboration = assessCorroboration(evidence);
  return {
    state: corroboration.state,
    publishers: corroboration.state === 'unknown' ? null : corroboration.publishers,
    roster: publisherRoster(evidence).map((publisher) => ({ name: publisher.name, tier: publisher.tier })),
  };
}

/** Value written to STORY_LABEL_FIELD, or null for a state the history does not track. */
export function encodeStoryLabel(label: StoryLabel): string | null {
  if (!isLabelHistoryState(label.state) || label.publishers === null) return null;
  return `${label.state}|${label.publishers}`;
}

export function decodeStoryLabel(raw: unknown): { state: LabelHistoryState; publishers: number } | null {
  if (typeof raw !== 'string') return null;
  const [state, count] = raw.split('|');
  const publishers = Number(count);
  if (!isLabelHistoryState(state) || !Number.isInteger(publishers) || publishers < 1) return null;
  return { state, publishers };
}

function isLabelHistoryState(value: unknown): value is LabelHistoryState {
  return (LABEL_HISTORY_STATES as readonly unknown[]).includes(value);
}

function reasonFor(next: LabelHistoryState, nextPublishers: number, previousPublishers: number): string {
  if (next === 'corroborated') {
    return `${nextPublishers} publisher families now carry this story (was ${previousPublishers}).`;
  }
  return `Only one publisher family carries this story in the latest digest (was ${previousPublishers}).`;
}

/**
 * The change between the label recorded last cycle and this cycle's, or null
 * when there is none to log: no previous label (a new story), an untracked
 * state on either side, or the same state.
 */
export function labelChangeFor(
  storyId: string,
  previousRaw: unknown,
  current: StoryLabel,
  context: { at: number; title: string; link: string; credibilityScore?: number | null },
): LabelChange | null {
  const previous = decodeStoryLabel(previousRaw);
  if (!previous || !isLabelHistoryState(current.state) || current.publishers === null) return null;
  if (previous.state === current.state) return null;
  return {
    storyId,
    field: 'corroboration',
    previous: previous.state,
    next: current.state,
    previousPublishers: previous.publishers,
    nextPublishers: current.publishers,
    at: context.at,
    trigger: 'digest',
    reason: reasonFor(current.state, current.publishers, previous.publishers),
    sources: current.roster.slice(0, ENTRY_PUBLISHERS_MAX),
    title: context.title,
    link: context.link,
    credibilityScore: Number.isFinite(context.credibilityScore) ? Math.round(context.credibilityScore as number) : null,
  };
}

/** Redis commands that append one change to both logs. */
export function labelChangeCommands(change: LabelChange): RedisPipelineCommand[] {
  const member = JSON.stringify(change);
  const storyKey = STORY_LABEL_HISTORY_KEY(change.storyId);
  return [
    ['LPUSH', LABEL_CHANGES_KEY, member],
    ['LTRIM', LABEL_CHANGES_KEY, 0, LABEL_CHANGES_MAX - 1],
    ['EXPIRE', LABEL_CHANGES_KEY, RETENTION_S],
    ['LPUSH', storyKey, member],
    ['LTRIM', storyKey, 0, STORY_LABEL_HISTORY_MAX - 1],
    ['EXPIRE', storyKey, RETENTION_S],
  ];
}

/**
 * Append changes, each at most once per guard window: two digest builds racing
 * over the same previous label would otherwise both log it. Returns the number
 * appended. Never throws; a failed write loses the entry, never the digest.
 */
export async function recordLabelChanges(changes: readonly LabelChange[], timeoutMs?: number): Promise<number> {
  if (changes.length === 0) return 0;
  const guards = await runRedisPipeline(
    changes.map((change) => [
      'SET', LABEL_CHANGE_GUARD_KEY(change.storyId, change.previous, change.next), String(change.at),
      'NX', 'EX', LABEL_CHANGE_GUARD_TTL_S,
    ]),
    false,
    timeoutMs,
  );
  const won = changes.filter((_, i) => guards[i]?.result === 'OK');
  if (won.length === 0) return 0;
  const results = await runRedisPipeline(won.flatMap(labelChangeCommands), false, timeoutMs);
  return results.length > 0 ? won.length : 0;
}

function asPublisher(raw: unknown): LabelChangePublisher | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, tier } = raw as { name?: unknown; tier?: unknown };
  if (typeof name !== 'string' || name === '') return null;
  return { name, tier: typeof tier === 'number' && tier >= 1 && tier <= 4 ? tier : null };
}

/** A stored entry, or null when it is malformed or older than the retention window. */
export function parseLabelChange(raw: unknown, now: number): LabelChange | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const at = Number(entry.at);
  if (!Number.isFinite(at) || at < now - LABEL_HISTORY_RETENTION_MS) return null;
  if (typeof entry.storyId !== 'string' || entry.storyId === '') return null;
  if (!isLabelHistoryState(entry.previous) || !isLabelHistoryState(entry.next)) return null;
  const previousPublishers = Number(entry.previousPublishers);
  const nextPublishers = Number(entry.nextPublishers);
  if (!Number.isInteger(previousPublishers) || !Number.isInteger(nextPublishers)) return null;
  const score = Number(entry.credibilityScore);
  return {
    storyId: entry.storyId,
    field: 'corroboration',
    previous: entry.previous,
    next: entry.next,
    previousPublishers,
    nextPublishers,
    at,
    trigger: entry.trigger === 'report' ? 'report' : 'digest',
    reason: typeof entry.reason === 'string' ? entry.reason : '',
    sources: Array.isArray(entry.sources)
      ? entry.sources.map(asPublisher).filter((p): p is LabelChangePublisher => p !== null)
      : [],
    title: typeof entry.title === 'string' ? entry.title : '',
    link: typeof entry.link === 'string' ? entry.link : '',
    credibilityScore: entry.credibilityScore !== null && Number.isFinite(score) ? score : null,
  };
}
