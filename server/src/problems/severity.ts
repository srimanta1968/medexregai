/**
 * F2.3 problem severity: high, medium or low, always with the reason shown next to
 * the problem. Rules, not a model, so the consultant can see why one problem comes
 * before another.
 */

export type Severity = 'high' | 'medium' | 'low';

export interface ScoredSeverity {
  severity: Severity;
  reason: string;
}

export interface ContradictionSide {
  sectionId: string | null;
  valueNum: number | null;
  value: string;
}

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
export const severityRank = (s: Severity): number => RANK[s];

/** A contradiction between two facts on one topic. */
export function contradictionSeverity(topicKey: string, a: ContradictionSide, b: ContradictionSide): ScoredSeverity {
  if (topicKey === 'shelf life') {
    const label = a.sectionId === 'labeling' ? a : b.sectionId === 'labeling' ? b : null;
    const other = label === a ? b : a;
    if (label && label.valueNum !== null && other.valueNum !== null && label.valueNum > other.valueNum) {
      return { severity: 'high', reason: 'The labeling claims a longer shelf life than the testing supports.' };
    }
    return { severity: 'high', reason: 'Shelf life is a labeling claim FDA checks against the ageing data.' };
  }
  if (topicKey === 'sterilization method' || topicKey === 'sterility assurance level') {
    return { severity: 'high', reason: 'Sterility claims must match the sterilization validation.' };
  }
  if (topicKey.startsWith('edition of ')) {
    return { severity: 'medium', reason: 'Documents cite different editions of the same standard; the submission should state which edition was used.' };
  }
  if (/diameter|french size|length/.test(topicKey)) {
    const fromLabel = a.sectionId === 'labeling' || b.sectionId === 'labeling';
    return fromLabel
      ? { severity: 'high', reason: 'A labeled dimension differs from the design or test documents.' }
      : { severity: 'medium', reason: 'A dimension differs between documents; the tested device may not be the described one.' };
  }
  return { severity: 'low', reason: 'Documents state different values.' };
}

/** Evidence the submission needs that is not in the project. */
export function gapSeverity(sectionId: string, triggered: boolean): ScoredSeverity {
  const core = ['device_description', 'indications_for_use', 'predicates_se', 'labeling', 'performance_testing'];
  if (core.includes(sectionId)) return { severity: 'high', reason: 'Every 510(k) needs this section.' };
  if (triggered && ['sterility', 'shelf_life', 'biocompatibility'].includes(sectionId)) {
    return { severity: 'high', reason: 'The documents describe the device in a way that needs this evidence.' };
  }
  return triggered
    ? { severity: 'medium', reason: 'The documents mention something that usually needs this evidence.' }
    : { severity: 'low', reason: 'May not apply to this device; confirm.' };
}
