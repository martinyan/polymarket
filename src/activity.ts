import { TraderActivity } from './types';

function toKeyPart(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim().toLowerCase();
}

export function normalizeActivity(activity: TraderActivity, fallbackUser: string): TraderActivity {
  return {
    ...activity,
    user: toKeyPart(activity.user || activity.proxyWallet || fallbackUser)
  };
}

function getFallbackActivityKey(activity: TraderActivity): string {
  return [
    toKeyPart(activity.user),
    toKeyPart(activity.asset),
    toKeyPart(activity.timestamp),
    toKeyPart(activity.price)
  ].join('-');
}

export function getActivityKeys(activity: TraderActivity): string[] {
  const keys = [toKeyPart(activity.id), toKeyPart(activity.transactionHash), getFallbackActivityKey(activity)].filter(Boolean);
  return Array.from(new Set(keys));
}

export function getPrimaryActivityId(activity: TraderActivity): string {
  return getActivityKeys(activity)[0] || 'unknown-activity';
}

export function hasSeenActivity(seen: Set<string>, activity: TraderActivity): boolean {
  return getActivityKeys(activity).some((key) => seen.has(key));
}

export function markActivitySeen(seen: Set<string>, activity: TraderActivity): void {
  for (const key of getActivityKeys(activity)) {
    seen.add(key);
  }
}
