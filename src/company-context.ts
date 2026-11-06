// get_context with scope company (SYS01 AC-A). The company block is stored as parts that every page can carry, so a block of any
// size reads back whole: each direction, goal and project is cut into parts of its JSON text, and every part carries the item's
// length and SHA-256. Pure: core stores the parts as a listing and pages them; the reader helper below is the contract the tests hold.
import { createHash } from 'node:crypto';
import { CompanyError } from './core-errors.ts';
import type { CompanyBrief, CompanyPart } from './contracts.ts';
import { ITEM_BUDGET_BYTES, dualBytes, utf8Segment } from './response-budget.ts';
import type { CompanySection } from './query-input.ts';

/** The most UTF-8 bytes of one item's JSON text a part carries. A part is also cut by the page budget (dualBytes), whichever is smaller. */
export const COMPANY_PART_BYTES = 16 * 1024;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The company block as one complete answer: paused, and the requested section (all three when none is named). */
export function companyBlock(brief: CompanyBrief, section?: CompanySection): Partial<CompanyBrief> & { paused: boolean } {
  return {
    paused: brief.paused,
    ...(section === undefined || section === 'directions' ? { directions: brief.directions } : {}),
    ...(section === undefined || section === 'projects' ? { projects: brief.projects } : {}),
  };
}

/** The parts of a company block: the meta part (paused), then each item of the requested sections, cut into parts in order. */
export function companyParts(brief: CompanyBrief, section?: CompanySection): CompanyPart[] {
  const items: Array<{ section: CompanyPart['section']; key: string; value: unknown }> = [{ section: 'meta', key: 'company', value: { paused: brief.paused } }];
  if (section === undefined || section === 'directions') {
    brief.directions.forEach((direction, position) => items.push({ section: 'directions', key: `direction-${position}`, value: direction }));
  }
  if (section === undefined || section === 'projects') for (const project of brief.projects) items.push({ section: 'projects', key: project.id, value: project });
  return items.flatMap(item => partsOf(item.section, item.key, JSON.stringify(item.value)));
}

/** One item's JSON text as parts: each at most COMPANY_PART_BYTES bytes, and small enough that its page answer fits the budget. */
function partsOf(section: CompanyPart['section'], key: string, json: string): CompanyPart[] {
  const totalBytes = Buffer.byteLength(json, 'utf8');
  const digest = sha256(json);
  // Measured with the largest numbers a part can print, so a part that fits here fits in the page it is sent in.
  const fits = (segment: { text: string }) => dualBytes({
    section, key, part: 99_999, parts: 99_999, offset: totalBytes, totalBytes, sha256: digest, json: segment.text,
  }) <= ITEM_BUDGET_BYTES;
  const cut: Array<{ offset: number; json: string }> = [];
  for (let offset = 0; ;) {
    const segment = utf8Segment(json, offset, COMPANY_PART_BYTES, fits);
    cut.push({ offset: segment.offset, json: segment.text });
    if (segment.next === null) break;
    offset = segment.next;
  }
  return cut.map((piece, part) => ({
    section, key, part, parts: cut.length, offset: piece.offset, totalBytes, sha256: digest, json: piece.json,
  }));
}

/**
 * The reader's side of the contract, as the tests and any client implement it: parts of one (section, key) item are joined in
 * order, their offsets must be contiguous, and the joined text must have the stated length and SHA-256 before it is parsed.
 * A missing, repeated or altered part is refused, never read as a shorter item.
 */
export function reassembleCompany(parts: readonly CompanyPart[]): Map<string, { section: CompanyPart['section']; key: string; value: unknown }> {
  const groups = new Map<string, CompanyPart[]>();
  for (const part of parts) {
    const name = `${part.section}\0${part.key}`;
    groups.set(name, [...(groups.get(name) ?? []), part]);
  }
  const items = new Map<string, { section: CompanyPart['section']; key: string; value: unknown }>();
  for (const [name, group] of groups) {
    const ordered = [...group].sort((a, b) => a.part - b.part);
    const first = ordered[0]!;
    if (ordered.length !== first.parts || ordered.some((part, index) => part.part !== index || part.parts !== first.parts)) {
      throw new CompanyError('invalid', `company part sequence of ${first.section} ${first.key} is incomplete or repeated`);
    }
    let text = '';
    let expectedOffset = 0;
    for (const part of ordered) {
      if (part.offset !== expectedOffset) throw new CompanyError('invalid', `company part offset of ${first.section} ${first.key} is not contiguous`);
      text += part.json;
      expectedOffset += Buffer.byteLength(part.json, 'utf8');
    }
    if (Buffer.byteLength(text, 'utf8') !== first.totalBytes || sha256(text) !== first.sha256) {
      throw new CompanyError('invalid', `company item ${first.section} ${first.key} does not match its length or SHA-256`);
    }
    items.set(name, { section: first.section, key: first.key, value: JSON.parse(text) as unknown });
  }
  return items;
}
