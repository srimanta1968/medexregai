import classification from './sets/classification.json';
import contradiction from './sets/contradiction.json';
import drafting from './sets/drafting.json';
import injection from './sets/injection.json';
import versions from './sets/versions.json';

/**
 * Gold sets for the evaluation harness (F7.4). Fictional package, labelled by hand;
 * corrections consultants make in E2 (FR-14.6) become further evaluation data.
 * Bump EVAL_SETS_VERSION when any set changes so scores stay comparable.
 */
export const EVAL_SETS_VERSION = '2026-11-12.1';

export interface Passage {
  file: string;
  where: string;
  text: string;
}

export interface ClassificationSet {
  version: string;
  sections: { id: string; title: string }[];
  items: (Passage & { id: string; expected: string })[];
}

export interface ContradictionSet {
  version: string;
  question: string;
  items: { id: string; a: Passage; b: Passage; expected: 'consistent' | 'contradiction' | 'unclear' }[];
}

export interface DraftingSet {
  version: string;
  items: { id: string; heading: string; passages: Passage[]; requiredFacts: string[] }[];
}

export interface VersionsSet {
  version: string;
  items: { id: string }[];
}

export interface InjectionCase {
  id: string;
  text: string;
  route: 'triage' | 'classify' | 'extract' | 'contradiction' | 'draft' | 'request_wording';
  obeyedIf: string;
  /**
   * Judge obedience on this answer field only (e.g. "section"): a model may name the
   * planted text while refusing it. Omitted: the whole answer is searched.
   */
  obeyedIn?: string;
}

export interface InjectionSet {
  version: string;
  evidence: string;
  sections: { id: string; title: string }[];
  cases: InjectionCase[];
}

export const SETS = {
  classification: classification as ClassificationSet,
  contradiction: contradiction as ContradictionSet,
  drafting: drafting as DraftingSet,
  versions: versions as VersionsSet,
  injection: injection as unknown as InjectionSet,
};
