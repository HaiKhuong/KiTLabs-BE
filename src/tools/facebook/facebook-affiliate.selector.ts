import { FacebookAffiliateStatus, FacebookSelectionRule } from "./facebook.enums";

export type AffiliateCandidate = {
  id: string;
  name: string;
  affiliateUrl: string;
  destinationUrl: string | null;
  productGroup: string;
  keywords: string[];
  pageIds: string[];
  status: FacebookAffiliateStatus | string;
  startsAt: Date | null;
  endsAt: Date | null;
};

export function selectAffiliateLinks(input: {
  links: AffiliateCandidate[];
  pageGraphId: string;
  content: string;
  count: number;
  rule: FacebookSelectionRule | string;
  cursor: number;
  now: Date;
  random?: () => number;
}): { picked: AffiliateCandidate[]; nextCursor: number } {
  const count = Math.max(0, Math.floor(input.count));
  const eligible = input.links.filter((link) => isEligible(link, input.pageGraphId, input.content, input.now));
  if (count === 0 || eligible.length === 0) return { picked: [], nextCursor: input.cursor };

  if (input.rule === FacebookSelectionRule.SEQUENTIAL) {
    const start = positiveMod(input.cursor, eligible.length);
    const picked = Array.from({ length: Math.min(count, eligible.length) }, (_, index) => eligible[(start + index) % eligible.length]);
    return { picked, nextCursor: start + picked.length };
  }

  if (input.rule === FacebookSelectionRule.GROUP) {
    return pickByGroup(eligible, count, input.cursor);
  }

  const random = input.random ?? Math.random;
  const pool = [...eligible];
  const picked: AffiliateCandidate[] = [];
  while (pool.length > 0 && picked.length < count) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(pool.splice(index, 1)[0]);
  }
  return { picked, nextCursor: input.cursor };
}

export function renderCommentTemplate(
  body: string,
  link: Pick<AffiliateCandidate, "name" | "affiliateUrl" | "destinationUrl">,
): string {
  return body
    .replaceAll("{name}", link.name)
    .replaceAll("{link}", link.affiliateUrl)
    .replaceAll("{destination}", link.destinationUrl ?? "");
}

function isEligible(link: AffiliateCandidate, pageGraphId: string, content: string, now: Date): boolean {
  if (link.status !== FacebookAffiliateStatus.ACTIVE) return false;
  if (link.startsAt && link.startsAt.getTime() > now.getTime()) return false;
  if (link.endsAt && link.endsAt.getTime() < now.getTime()) return false;
  if (link.pageIds.length > 0 && !link.pageIds.includes(pageGraphId)) return false;
  const keywords = link.keywords.map((item) => item.trim()).filter(Boolean);
  if (keywords.length === 0) return true;
  const haystack = content.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function pickByGroup(
  eligible: AffiliateCandidate[],
  count: number,
  cursor: number,
): { picked: AffiliateCandidate[]; nextCursor: number } {
  const groups = new Map<string, AffiliateCandidate[]>();
  for (const link of eligible) {
    const key = link.productGroup.trim() || link.id;
    const bucket = groups.get(key) ?? [];
    bucket.push(link);
    groups.set(key, bucket);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const picked: AffiliateCandidate[] = [];
  const start = positiveMod(cursor, keys.length);
  for (let step = 0; step < keys.length && picked.length < count; step += 1) {
    const key = keys[(start + step) % keys.length];
    const bucket = groups.get(key) ?? [];
    const offset = Math.floor(cursor / keys.length) % bucket.length;
    picked.push(bucket[offset]);
  }
  return { picked, nextCursor: cursor + picked.length };
}

function positiveMod(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((Math.floor(value) % length) + length) % length;
}
