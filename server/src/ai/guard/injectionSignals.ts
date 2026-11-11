import { countHiddenCharacters, foldFullWidth, stripHidden } from './sanitize';

/**
 * Finds text in client files that reads like instructions to an AI (F7.5, NFR-16).
 *
 * This is a warning for the consultant, not the defence: whatever it finds, the text
 * is still passed to models only as delimited data, document routes have no tools,
 * and outputs are schema-checked. Detection never blocks a file or changes what the
 * system does with it; it only tells the reviewer that a file contains text worth a
 * second look (a planted instruction is itself a finding about the evidence).
 *
 * Patterns stay narrow on purpose: device test reports are full of imperative
 * sentences ("ignore the first three cycles", "use the torque tool"), so a signal
 * needs wording aimed at a model, its instructions or its output.
 */

export type InjectionSignalKind = 'override' | 'role_change' | 'template_token' | 'hidden_text' | 'exfiltration' | 'tool_call' | 'addressed_to_ai';

export interface InjectionSignal {
  kind: InjectionSignalKind;
  /** source_locations.ordinal of the passage, when scanned per passage. */
  ordinal: number | null;
  /** Where in the file (page, sheet + cells, slide or heading). */
  where: string | null;
  /** Up to 120 characters around the match, whitespace collapsed. */
  excerpt: string;
}

interface Rule {
  kind: InjectionSignalKind;
  re: RegExp;
}

/** Who a planted instruction addresses. Strict: never a person's name or a device's own "AI model". */
const AGENT_STRICT = String.raw`(?:AI assistant|language model|LLM|chat ?bot|ChatGPT|GPT-\d+|Copilot|MedexRegAI)`;
const AGENT_ANY = String.raw`(?:${AGENT_STRICT}|AI model|AI system|AI tool)`;
const DIRECTIVE = String.raw`(?:you\b|ignore|disregard|forget|new instructions?|from now on|reveal|act as|pretend|respond|reply|output|print)`;

const RULES: Rule[] = [
  {
    kind: 'override',
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the system'?s?|these)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules|directions|guidelines|guardrails|constraints|context)\b/gi,
  },
  {
    kind: 'role_change',
    re: /\b(?:you are now|from now on,? you|pretend (?:to be|you are)|act as (?:an?|the) (?:different|new|unrestricted)|new (?:system )?instructions?\s*:|(?:reveal|print|show|repeat|output|ignore|disregard|leak) (?:the |your )?(?:system|hidden|original) (?:prompt|instructions)|(?:enable|enter|activate|switch to) developer mode|developer mode (?:enabled|activated|on)\b|jailbreak|DAN mode)/gi,
  },
  { kind: 'role_change', re: new RegExp(String.raw`^\s*(?:#{1,6}\s*)?(?:system|assistant|developer)\s*:\s*${DIRECTIVE}`, 'gim') },
  {
    kind: 'template_token',
    re: /<\|\s*[a-z_]{2,24}\s*\|>|\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>|<\s*\/?\s*(?:system|assistant|developer|instructions?)\s*>|\b(?:BEGIN|END)[_ -]?DATA\b/gi,
  },
  {
    kind: 'exfiltration',
    re: /!\[[^\]]{0,80}\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*\)|\b(?:send|e-?mail|post|upload|forward|exfiltrate|transmit|leak)\b (?:the |all |this |these |your |the following )(?:extracted |above |raw )?(?:data|values|results|information|contents?|text|prompt|answers?|summary|facts)\b[^.\n]{0,40}?\b(?:to|at)\b\s*(?:https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+)/gi,
  },
  {
    kind: 'tool_call',
    re: /\b(?:call|invoke|use|run|trigger)\b (?:the |a |your )?\w+_\w+ (?:tool|function)\b|\b(?:call|invoke) (?:the |a |your |any |a different )?tools?\b|"(?:tool_use|tool_calls|function_call)"/gi,
  },
  {
    kind: 'addressed_to_ai',
    re: new RegExp(
      [
        String.raw`\b(?:note|attention|instruction|message)s?,? (?:to |for )?(?:the |any |all )?${AGENT_ANY}\b`,
        String.raw`\b(?:dear|hey|hello|hi),? ${AGENT_STRICT}\b`,
        String.raw`\b(?:if you are|you are) an? ${AGENT_ANY}\b`,
        String.raw`\bas an? ${AGENT_ANY},? you\b`,
        String.raw`\b${AGENT_STRICT}s?\b[^.\n]{0,30}?\b(?:must|should|shall|will|need to)\b[^.\n]{0,30}?\b(?:classify|mark|rate|approve|accept|report|say|respond|reply|output|state|conclude|treat|ignore)\b`,
      ].join('|'),
      'gi',
    ),
  },
];

export const MAX_STORED_SIGNALS = 50;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`.slice(0, 120);
}

/** Signals in one piece of text. */
export function findInjectionSignals(raw: string, at: { ordinal?: number | null; where?: string | null } = {}): InjectionSignal[] {
  const out: InjectionSignal[] = [];
  const base = { ordinal: at.ordinal ?? null, where: at.where ?? null };
  const hidden = countHiddenCharacters(raw);
  if (hidden > 0) out.push({ kind: 'hidden_text', ...base, excerpt: `${hidden} invisible character${hidden === 1 ? '' : 's'} (removed before any AI step)` });
  // Match on what a model would read: invisible characters dropped, full-width letters folded.
  const text = stripHidden(foldFullWidth(raw));
  const seen = new Set<string>();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex += 1;
        continue;
      }
      const key = `${rule.kind}:${Math.floor(m.index / 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: rule.kind, ...base, excerpt: excerptAround(text, m.index, m[0].length) });
    }
  }
  return out;
}

export interface InjectionScanResult {
  signals: InjectionSignal[];
  /** Signals beyond the stored cap. */
  truncated: number;
}

/** Signals across a file's passages (ingest). */
export function scanForInjection(passages: { ordinal: number; text: string; where: string }[]): InjectionScanResult {
  const all: InjectionSignal[] = [];
  for (const p of passages) all.push(...findInjectionSignals(p.text, { ordinal: p.ordinal, where: p.where }));
  return { signals: all.slice(0, MAX_STORED_SIGNALS), truncated: Math.max(0, all.length - MAX_STORED_SIGNALS) };
}
