const INTERNAL_ANATOMY_RE = /\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)\b/i;
const CALLOUT_DUMP_RE = /^\s*(?:(?:visual\s+)?(?:callouts?|references?)\s+for|visual reference for)\b/i;
const INCIDENTAL_OBJECT_RE = /\b(?:ecg|chest[-\s]?strap|polar\s*h10|heart[-\s]?rate monitor|headphones?|bone[-\s]?conduction|foot cameras?|camera devices?|table paper|stirrups?|clinician perspective|room contents?|room setup|furniture|background objects?|environmental objects?)\b/i;
const PROVENANCE_RE = /\b(?:in this batch|this batch|this pass|current pass|latest pass|prior batches?|subsequent batches?|later batch|current image subset|current reviewed set|current reviewed images?|current image set|current \d+[-\s]?image set|image subset|recent photos?|newest photos?|rechecked saved\/direct views?|saved\/direct views?|direct views linked into cumulative review|fresh images added this run|generated at|image set overview|reference value for pulsepoint|coverage map: no distinct recovered batch paragraph|no distinct recovered batch paragraph|assembled from|source details?|provenance|evidence records?|prior documentation|confidence accumulation|baseline establishment|historical mistakes?|prior corrections?|invalidated findings?|correction history)\b/i;
const CAMERA_SETUP_RE = /\b(?:foot-of-table|camera angle|camera location|clinician perspective|table-position|session table|treatment table|table paper|stirrups?|lighting is|well-lit|image quality|frame edge|field of view|background)\b/i;
const DEVICE_KEEP_RE = /\b(?:catheter|foley|urethral|sound|dilator|rectal|anal device|sleeve|device contact|contact zone|fit|tissue interaction|marker)\b/i;
const BOOKKEEPING_SENTENCE_RE = /\b(?:evidence records?|prior documentation|strongly established|confidence accumulation|baseline establishment|prior corrections?|invalidated findings?|correction history|historical mistakes?|profile reconciliation|saved\/direct views?|rechecked saved\/direct views?)\b/i;
const UI_CALLOUT_RE = /\b(?:clarify\s*\/\s*correct|remove callout|visual reference for|callouts?|direct visual|directly rechecked|reviewed image|image reference ids?|structured callouts?)\b/i;
const PROFILE_FINDING_NOVELTY_RE = /\b(?:new|newly|changed?|change|progress(?:ion|ed|ing)?|worsen(?:ed|ing)?|improv(?:ed|ing|ement)?|increase(?:d|s|ing)?|decrease(?:d|s|ing)?|reduc(?:ed|ing|tion)|resolved?|healing|evolving|current(?:ly)?|prior|previous|earlier|later|compared|comparison|from\s+\w+\s+to|now|no longer|more|less|greater|smaller|larger|mild|moderate|marked|severe|subtle|diffuse|focal|asymmetr(?:y|ic)|bilateral|unilateral|right|left|anterior|posterior|lateral|supine|standing|erect|flaccid|catheter|foley|meatus|glans|foreskin|shaft|scrot|perineal|perianal|fissure|ulcer|infection|open skin break)\b/i;
const PROFILE_FINDING_NEGATIVE_RE = /\b(?:no|without|absent|not visible|not evident|not seen|no visible|no obvious|no open|no signs? of)\b/i;
const PROFILE_FINDING_CONSOLIDATION = "Confirmed across multiple views.";

const PROFILE_FINDING_REGISTRY = [
  { key: "head.face.hair.salt_pepper", region: "head_face", re: /\b(?:short\s+)?salt[-\s]?and[-\s]?pepper\s+hair\b/i },
  { key: "head.face.hair.vertex_thinning", region: "head_face", re: /\b(?:mild\s+)?vertex\s+thinning\b|\bthinning\s+(?:at|over)\s+the\s+vertex\b/i },
  { key: "head.face.glasses.wire_frame", region: "head_face", re: /\bwire[-\s]?frame\s+glasses\b|\bglasses\b/i },
  { key: "head.face.goatee.grey_predominance", region: "head_face", re: /\bgoatee\b|\bgr[ae]y\s+predominance\b/i },
  { key: "head.face.rounded_facial_contour", region: "head_face", re: /\brounded\s+facial\s+contour\b/i },
  { key: "head.face.submental_fullness", region: "head_face", re: /\bsubmental\s+fullness\b/i },
  { key: "posture.forward_head_carriage", region: "posture_alignment", re: /\bforward\s+head\s+(?:carriage|posture)\b/i },
  { key: "posture.thoracic_kyphosis", region: "posture_alignment", re: /\bthoracic\s+kyphosis\b|\bkyphotic\b/i },
  { key: "posture.lumbar_lordosis", region: "posture_alignment", re: /\blumbar\s+lordosis\b|\blordotic\b/i },
  { key: "posture.right_shoulder_elevation", region: "posture_alignment", re: /\bright\s+shoulder\b[^.]{0,60}\belevat/i },
  { key: "abdomen.right_inguinal_hernia_scar", region: "abdomen_pelvis", re: /\bright\s+inguinal\s+hernia\s+repair\s+scar\b|\binguinal\b[^.]{0,50}\bscar\b/i },
  { key: "abdomen.dog_bite_healing", region: "abdomen_pelvis", re: /\bdog\s+bite\b|\bbite\s+wound\b|\byellow[-\s]?green\s+bruise\b|\bbruise\s+resolution\b|\bhealing\s+progression\b/i },
  { key: "skin.follicular_papules", region: "skin_surface", re: /\bfollicular\b[^.]{0,80}\bpapules?\b|\berythematous\s+papules?\b|\bpapular\b[^.]{0,80}\bfollicular\b/i },
  { key: "skin.striae", region: "skin_surface", re: /\bpale\s+linear\s+striae\b|\bstriae\b/i },
  { key: "skin.no_open_breaks_infection", region: "skin_surface", negative: true, re: /\bno\s+(?:visible\s+)?(?:open\s+)?skin\s+breaks?\b|\bno\s+(?:visible\s+)?signs?\s+of\s+(?:secondary\s+)?infection\b|\bno\s+visible\s+infection\b|\bwithout\s+(?:open\s+)?skin\s+breaks?\b/i },
  { key: "feet.no_edema", region: "lower_limbs_feet", negative: true, re: /\bno\s+(?:visible\s+)?(?:ankle|foot|pedal|lower[-\s]?extremity)?\s*edema\b|\bwithout\s+(?:visible\s+)?edema\b/i },
  { key: "genital.meatus", region: "pelvic_genital", pelvic: true, re: /\bmeat(?:al|us)\b/i },
  { key: "genital.glans", region: "pelvic_genital", pelvic: true, re: /\bglans\b/i },
  { key: "genital.foreskin", region: "pelvic_genital", pelvic: true, re: /\bforeskin\b|\bprepuce\b/i },
  { key: "genital.shaft", region: "pelvic_genital", pelvic: true, re: /\bpenile\s+shaft\b|\bshaft\b/i },
  { key: "genital.scrotum", region: "pelvic_genital", pelvic: true, re: /\bscrot(?:um|al)\b|\btest(?:es|icular)\b/i },
  { key: "genital.perineal_raphe", region: "pelvic_genital", pelvic: true, re: /\bperineal\s+raphe\b|\bscrotal\s+raphe\b|\bperineal\s+body\b/i },
  { key: "genital.perianal", region: "pelvic_genital", pelvic: true, re: /\bperianal\b|\banal\s+verge\b|\banal\s+opening\b/i },
  { key: "catheter.foley_present", region: "pelvic_genital", pelvic: true, re: /\bfoley\b|\bcatheter\b|\bstatlock\b|\bmeatal\s+exit\b/i },
];

function normalizeForbiddenPhrasing(value = "") {
  return String(value || "")
    .replace(/\bfrom (?:a )?foot-of-table (?:clinician )?perspective\b/gi, "")
    .replace(/\bin (?:the )?(?:right|left)?\s*lateral standing view\b/gi, "in standing profile")
    .replace(/\bin (?:the )?anterior standing view\b/gi, "in standing posture")
    .replace(/\bin (?:the )?posterior standing view\b/gi, "from posterior standing posture")
    .replace(/\bin (?:image|photo)\s+\d+\b/gi, "")
    .replace(/\b(?:image|photo)\s+\d+\s*(?:and|,)?\s*/gi, "")
    .replace(/\b(?:this|the)\s+(?:image|photo|view)\s+(?:shows|provides|confirms)\b/gi, "visible findings show")
    .replace(/\b(?:this|the)\s+(?:batch|image set|review run|pass|current pass|latest pass)\b/gi, "the cumulative review")
    .replace(/\b(?:the\s+)?(?:current\s+)?image subset\b/gi, "the cumulative review")
    .replace(/\b(?:the\s+)?current reviewed set\b/gi, "the cumulative review")
    .replace(/\b(?:the\s+)?current image set\b/gi, "the cumulative review")
    .replace(/\b(?:the\s+)?current\s+\d+[-\s]?image set\b/gi, "the cumulative review")
    .replace(/\b(?:recent|newest)\s+photos?\b/gi, "current update evidence")
    .replace(/\b(?:remains|is|appears)\s+consistent\s+with\s+(?:the\s+)?(?:strongly\s+)?(?:established\s+)?(?:prior\s+)?(?:baseline|prior documentation|evidence records?)\b/gi, "appears unchanged")
    .replace(/\bconsistent\s+with\s+(?:the\s+)?(?:strongly\s+)?(?:established\s+)?(?:prior\s+)?(?:baseline|prior documentation|evidence records?)\b/gi, "unchanged")
    .replace(/\b(?:strongly\s+)?established\s+baseline\s+(?:finding|evidence|profile)\b/gi, "current finding")
    .replace(/\b(?:prior|saved)\s+documentation\b/gi, "saved review")
    .replace(/\bnot directly visible in any current image\b/gi, "not newly refreshed")
    .replace(/\bnot directly visible in any current images\b/gi, "not newly refreshed")
    .replace(/\bnot directly visible in any reviewed image\b/gi, "not newly refreshed")
    .replace(/\bnot directly visible in any reviewed images\b/gi, "not newly refreshed")
    .replace(/\bnot directly visible in any current view\b/gi, "not newly refreshed")
    .replace(/\bnot directly visible in any current views\b/gi, "not newly refreshed")
    .replace(/\bno direct coverage in the current[^.]*\./gi, "")
    .replace(/\bno direct coverage from the current[^.]*\./gi, "")
    .replace(/\b(?:the\s+)?current\s+\d+[-\s]?image\s+set\b/gi, "latest update evidence")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sentenceChunks(value = "") {
  return String(value || "")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFindingSupportText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s-]+/g, " ")
    .replace(/\b(?:the|a|an|this|that|these|those|visible|shows?|appears?|noted|seen|view|views|image|images|photo|photos|current|cumulative|review|reviewed|baseline|finding|findings|is|are|was|were|with|and|or|of|in|on|at|from|to|across)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findingEvidenceTokens(value = "") {
  return new Set(
    normalizeFindingSupportText(value)
      .split(/\s+/)
      .filter((token) => token.length > 3)
  );
}

function profileFindingMatches(value = "") {
  const text = String(value || "");
  if (!text.trim()) return [];
  return PROFILE_FINDING_REGISTRY.filter((entry) => entry.re.test(text)).map((entry) => ({
    ...entry,
    negative: entry.negative || PROFILE_FINDING_NEGATIVE_RE.test(text),
  }));
}

function isMeaningfullyNewFindingMention(sentence = "", record = {}, matches = []) {
  const text = String(sentence || "");
  if (!record?.firstText) return true;
  if (matches.some((match) => match.pelvic) && /\b(?:meatus|glans|foreskin|prepuce|shaft|scrot|testes|perineal|perianal|anal|catheter|foley|statlock|erect|flaccid)\b/i.test(text)) {
    const priorTokens = record.tokens || new Set();
    const currentTokens = findingEvidenceTokens(text);
    let newStructureTokens = 0;
    for (const token of currentTokens) {
      if (!priorTokens.has(token) && /^(?:meat|glans|foreskin|prepuce|shaft|scrot|test|perine|perian|anal|foley|catheter|statlock|erect|flaccid|dorsal|ventral)$/i.test(token)) {
        newStructureTokens += 1;
      }
    }
    if (newStructureTokens > 0) return true;
  }
  if (!PROFILE_FINDING_NOVELTY_RE.test(text)) return false;
  const previous = record.tokens || new Set();
  const current = findingEvidenceTokens(text);
  let novelTokens = 0;
  for (const token of current) {
    if (!previous.has(token)) novelTokens += 1;
  }
  if (record.negative && PROFILE_FINDING_NEGATIVE_RE.test(text) && novelTokens < 4) return false;
  return novelTokens >= 3;
}

function appendFindingSupport(sentence = "", record = {}) {
  const text = String(sentence || "").trim();
  if (!text) return text;
  if (record.supportCount < 2) return text;
  if (/\bconfirmed across multiple views\b/i.test(text)) return text;
  if (record.hasNovelMentions) return text;
  return `${text.replace(/\s+$/g, "")} ${PROFILE_FINDING_CONSOLIDATION}`;
}

function replaceFirstFindingMention(value = "", from = "", to = "") {
  const text = String(value || "");
  if (!text || !from || !to || from === to) return text;
  const index = text.indexOf(from);
  if (index < 0) return text;
  return `${text.slice(0, index)}${to}${text.slice(index + from.length)}`;
}

function applyProfileFindingSupportSummaries(result = {}, registry = new Map(), sections = []) {
  if (!result || typeof result !== "object") return result;
  const replacements = [...registry.values()]
    .map((record) => ({
      from: record.firstText,
      to: appendFindingSupport(record.firstText, record),
    }))
    .filter((item) => item.from && item.to && item.from !== item.to);
  if (!replacements.length) return result;

  const applyToText = (value = "") => {
    let next = String(value || "");
    for (const replacement of replacements) {
      next = replaceFirstFindingMention(next, replacement.from, replacement.to);
    }
    return next;
  };

  const next = { ...result, overview: applyToText(result.overview || "") };
  if (next.summary_card && typeof next.summary_card === "object") {
    next.summary_card = { ...next.summary_card };
    for (const key of ["baseline_quality", "coverage", "evidence_note"]) {
      next.summary_card[key] = applyToText(next.summary_card[key] || "");
    }
    for (const key of ["primary_reference_value", "key_direct_findings", "key_limitations"]) {
      next.summary_card[key] = Array.isArray(next.summary_card[key])
        ? next.summary_card[key].map((item) => applyToText(item)).filter(Boolean)
        : [];
    }
  }
  for (const section of sections) {
    if (Array.isArray(next[section.key])) {
      next[section.key] = next[section.key].map((item) => applyToText(item)).filter(Boolean);
    }
  }
  if (Array.isArray(next.image_region_findings)) {
    next.image_region_findings = next.image_region_findings.map((finding) => ({
      ...finding,
      finding: applyToText(finding?.finding || ""),
    }));
  }
  return next;
}

function reduceProfileFindingSentenceList(sentences = [], registry, sectionKey = "") {
  const output = [];
  for (const rawSentence of sentences) {
    const sentence = String(rawSentence || "").trim();
    if (!sentence) continue;
    const matches = profileFindingMatches(sentence);
    if (!matches.length) {
      output.push(sentence);
      continue;
    }

    const repeatedMatches = [];
    const novelMatches = [];
    for (const match of matches) {
      const existing = registry.get(match.key);
      if (!existing) {
        novelMatches.push(match);
        continue;
      }
      existing.supportCount += 1;
      existing.sections.add(sectionKey || "general");
      if (isMeaningfullyNewFindingMention(sentence, existing, matches)) {
        existing.hasNovelMentions = true;
        const nextTokens = findingEvidenceTokens(sentence);
        for (const token of nextTokens) existing.tokens.add(token);
        novelMatches.push(match);
      } else {
        repeatedMatches.push(match);
      }
    }

    if (novelMatches.length || !repeatedMatches.length) {
      output.push(sentence);
      for (const match of matches) {
        if (!registry.has(match.key)) {
          registry.set(match.key, {
            key: match.key,
            region: match.region,
            negative: match.negative,
            firstText: sentence,
            supportCount: 1,
            hasNovelMentions: false,
            sections: new Set([sectionKey || "general"]),
            tokens: findingEvidenceTokens(sentence),
          });
        }
      }
    }
  }
  return output;
}

function reduceProfileFindingRepetitionInItems(items = [], registry, sectionKey = "") {
  return items
    .map((item) => {
      const chunks = sentenceChunks(item);
      const reduced = reduceProfileFindingSentenceList(chunks, registry, sectionKey).join(" ").trim();
      return reduced;
    })
    .filter(Boolean);
}

export function reduceProfileFindingRepetition(result = {}, { sections = [] } = {}) {
  if (!result || typeof result !== "object") return result;
  const cleaned = { ...result };
  const registry = new Map();

  cleaned.overview = reduceProfileFindingRepetitionInItems([cleaned.overview || ""], registry, "overview")[0] || "";

  if (cleaned.summary_card && typeof cleaned.summary_card === "object") {
    cleaned.summary_card = { ...cleaned.summary_card };
    for (const key of ["baseline_quality", "coverage", "evidence_note"]) {
      cleaned.summary_card[key] = reduceProfileFindingRepetitionInItems([cleaned.summary_card[key] || ""], registry, `summary_card.${key}`)[0] || "";
    }
    for (const key of ["primary_reference_value", "key_direct_findings", "key_limitations"]) {
      cleaned.summary_card[key] = Array.isArray(cleaned.summary_card[key])
        ? reduceProfileFindingRepetitionInItems(cleaned.summary_card[key], registry, `summary_card.${key}`)
        : [];
    }
  }

  for (const section of sections) {
    if (Array.isArray(cleaned[section.key])) {
      cleaned[section.key] = reduceProfileFindingRepetitionInItems(cleaned[section.key], registry, section.key);
    }
  }

  if (Array.isArray(cleaned.image_region_findings)) {
    const localImageFindingRegistry = new Map();
    cleaned.image_region_findings = cleaned.image_region_findings
      .map((finding) => {
        const text = reduceProfileFindingRepetitionInItems([finding?.finding || ""], localImageFindingRegistry, `image_region_findings.${finding?.section_key || ""}`)[0] || "";
        return text ? { ...finding, finding: text } : null;
      })
      .filter(Boolean);
  }

  return applyProfileFindingSupportSummaries(cleaned, registry, sections);
}

function shouldDropSentence(sentence = "") {
  const text = String(sentence || "");
  if (!text.trim()) return true;
  if (CALLOUT_DUMP_RE.test(text)) return true;
  if (UI_CALLOUT_RE.test(text)) return true;
  if (INTERNAL_ANATOMY_RE.test(text)) return true;
  if (PROVENANCE_RE.test(text)) return true;
  if (/^\s*(?:not represented|not visible|not directly reassessed|not included|not available)\s+in\s+(?:this|the)\s+(?:pass|current pass|latest pass|image subset|current image subset|batch|image set)\.?\s*$/i.test(text)) return true;
  if (/^\s*(?:head|neck|chest|shoulders?|upper limbs?|posterior trunk|head, neck, chest, upper limbs, and posterior trunk)(?:,\s*(?:head|neck|chest|shoulders?|upper limbs?|posterior trunk))*\s+have\s*\.?\s*$/i.test(text)) return true;
  if (/^\s*(?:no\s+)?[a-z][a-z\s/&-]{1,60}\s+(?:images?\s+are\s+present|views?\s+are\s+present|coverage\s+is\s+present|is\s+not\s+directly\s+visible|are\s+not\s+directly\s+visible|not\s+directly\s+visible)\s+in\s+(?:the\s+)?current(?:ly)?\s+(?:reviewed\s+)?(?:set|images?|views?)\.?\s*$/i.test(text)) return true;
  if (/^\s*(?:not represented|not visible|not directly reassessed|not included|not available)\s+in\s+the\s+cumulative\s+review\.?\s*$/i.test(text)) return true;
  if (/^\s*[a-z][a-z\s/&-]{1,60}\s+(?:not represented|not visible|not directly reassessed|not included|not available)\s+in\s+(?:the cumulative|this|the)\s+(?:pass|current pass|latest pass|image subset|current image subset|batch|image set|review)\.?\s*$/i.test(text)) return true;
  if (/^\s*(?:stable from prior established baseline|stable from established baseline|baseline carried forward|carried forward from prior baseline)\.?\s*$/i.test(text)) return true;
  if (BOOKKEEPING_SENTENCE_RE.test(text) && !/\b(?:bruise|wound|healing|swelling|lesion|scar|catheter|foley|meatus|glans|penis|scrot|skin|edema|irritation|redness|fissure|ulcer|rash|papules?)\b/i.test(text)) return true;
  if (/\b(?:correction|invalidated|historical mistake|profile reconciliation)\b/i.test(text)) return true;
  if (INCIDENTAL_OBJECT_RE.test(text) && !DEVICE_KEEP_RE.test(text)) return true;
  if (CAMERA_SETUP_RE.test(text) && !/\b(?:posture|alignment|supine|standing|prone|seated|lithotomy|abduction|flexion|extension)\b/i.test(text)) return true;
  if (/\bthe cumulative review does not include\b/i.test(text)) return true;
  if (/\b(?:not visible|not included|not provided|not available|deferred)\b/i.test(text) && /\b(?:batch|image set|prior|subsequent|later|rechecked)\b/i.test(text)) return true;
  if (/\bnot newly refreshed\b/i.test(text) && !/\b(?:help|useful|future|next|refresh)\b/i.test(text)) return true;
  if (/^\s*(?:this|the)\s+(?:finding|observation|region|section)\s+appears unchanged\.?\s*$/i.test(text)) return true;
  return false;
}

export function cleanProfileImageReviewText(value = "") {
  const raw = String(value || "");
  if (!raw.trim()) return "";
  if (CALLOUT_DUMP_RE.test(raw)) return "";
  if (UI_CALLOUT_RE.test(raw)) return "";
  if (INCIDENTAL_OBJECT_RE.test(raw) && !DEVICE_KEEP_RE.test(raw)) return "";

  let text = normalizeForbiddenPhrasing(raw)
    .replace(/\bThis batch does not include[^.]*\.?\s*/gi, "")
    .replace(/\bThis image set does not include[^.]*\.?\s*/gi, "")
    .replace(/\bThis pass does not include[^.]*\.?\s*/gi, "")
    .replace(/\bThe current pass does not include[^.]*\.?\s*/gi, "")
    .replace(/\bAll \d+ rechecked saved\/direct views[^.]*\.?\s*/gi, "")
    .replace(/\b\d+ direct views linked into cumulative review\.?\s*/gi, "")
    .replace(/\bNo distinct recovered batch paragraph[^.]*\.?\s*/gi, "")
    .replace(/\bCoverage Map:\s*No distinct recovered batch paragraph[^.]*\.?\s*/gi, "")
    .replace(/\bNo (?:whole-body|full-body|torso|standing|posterior|anterior|lateral|upper limb|lower limb|foot|feet)[^.]*?(?:in this batch|in this image set|were included|were provided)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:Head|Neck|Chest|Shoulders?|Upper limbs?|Posterior trunk|Head, neck, chest, upper limbs, and posterior trunk)[^.]*?(?:no direct coverage|not directly visible|not represented|not included)[^.]*?(?:current|reviewed|image set|images|views)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:Head|Neck|Chest|Shoulders?|Upper limbs?|Posterior trunk|Head, neck, chest, upper limbs, and posterior trunk)\s+have\s*\.?\s*/gi, "")
    .replace(/\bnot visible in this batch\.?\s*/gi, "")
    .replace(/\bnot visible in this pass\.?\s*/gi, "")
    .replace(/\bnot represented in this pass\.?\s*/gi, "")
    .replace(/\bnot directly reassessed in this pass\.?\s*/gi, "")
    .replace(/\bnot visible in the current image subset\.?\s*/gi, "")
    .replace(/\bnot represented in the current image subset\.?\s*/gi, "")
    .replace(/\b(?:No\s+)?[A-Z][A-Za-z\s/&-]{1,60}\s+(?:images?\s+are\s+present|views?\s+are\s+present|coverage\s+is\s+present|is\s+not\s+directly\s+visible|are\s+not\s+directly\s+visible|not\s+directly\s+visible)\s+in\s+(?:the\s+)?current(?:ly)?\s+(?:reviewed\s+)?(?:set|images?|views?)\.?\s*/g, "")
    .replace(/\b(?:current reviewed set|current image set|current \d+[-\s]?image set)\b/gi, "cumulative review")
    .replace(/\b[a-z][a-z\s/&-]{1,60}\s+(?:not represented|not visible|not directly reassessed|not included|not available)\s+in\s+(?:the cumulative|this|the)\s+(?:pass|current pass|latest pass|image subset|current image subset|batch|image set|review)\.?\s*/gi, "")
    .replace(/\bnot visible in the cumulative review\.?\s*/gi, "")
    .replace(/\bnot represented in the cumulative review\.?\s*/gi, "")
    .replace(/\bnot directly reassessed in the cumulative review\.?\s*/gi, "")
    .replace(/\bnot provided in this batch\.?\s*/gi, "")
    .replace(/\bnot included in this batch\.?\s*/gi, "")
    .replace(/\bStable from prior established baseline\.?\s*/gi, "")
    .replace(/\bBaseline carried forward\.?\s*/gi, "")
    .replace(/\b(?:This|The)\s+(?:finding|observation|region|section)\s+(?:remains|is)\s+consistent\s+with\s+(?:the\s+)?(?:strongly\s+)?(?:established\s+)?(?:baseline|prior documentation|evidence records?)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:Prior corrections?|Invalidated findings?|Correction history|Historical mistakes?)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:evidence records?|prior documentation|confidence accumulation|baseline establishment|profile reconciliation)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:remains|is|appears)\s+consistent\s+with\s+(?:the\s+)?(?:strongly\s+)?(?:established\s+)?(?:prior\s+)?(?:baseline|prior documentation|evidence records?)\b/gi, "appears unchanged")
    .replace(/\bconsistent\s+with\s+(?:the\s+)?(?:strongly\s+)?(?:established\s+)?(?:prior\s+)?(?:baseline|prior documentation|evidence records?)\b/gi, "unchanged")
    .replace(/\bdeferred to (?:another|subsequent|later) batch[^.]*\.?\s*/gi, "")
    .replace(/\b(?:prior|subsequent|later) batches?[^.]*\.?\s*/gi, "")
    .replace(/\b(?:ECG|Polar H10|chest[-\s]?strap|heart[-\s]?rate monitor|bone[-\s]?conduction headphones?|headphones?|foot cameras?|camera devices?|table paper|stirrups?)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:Visual reference for|Clarify\s*\/\s*correct|Remove callout)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:No|The)\s+(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*?(?:not visible|not visualized|not assessable|not assessed)[^.]*\.?\s*/gi, "")
    .replace(/\b(?:lubricant residue|possible lubricant residue|natural moisture or possible lubricant residue)\b/gi, "surface sheen/moisture; source cannot be determined from static image")
    .replace(/\s{2,}/g, " ")
    .trim();

  text = sentenceChunks(text).filter((sentence) => !shouldDropSentence(sentence)).join(" ").trim();
  if (!text || INTERNAL_ANATOMY_RE.test(text)) return "";
  if (PROVENANCE_RE.test(text)) return "";
  if (UI_CALLOUT_RE.test(text)) return "";
  if (INCIDENTAL_OBJECT_RE.test(text) && !DEVICE_KEEP_RE.test(text)) return "";
  if (/\bmeat(?:al|us)\b/i.test(text) && /\b(?:bright|highlight|fluid|droplet|secretion|pre[-\s]?ejaculate)\b/i.test(text)) {
    return "Small bright meatal highlight or possible fluid point; static image cannot confirm secretion.";
  }
  return text;
}

function cleanProfileImageMetadataText(value = "") {
  return normalizeForbiddenPhrasing(String(value || ""))
    .replace(/\bwhole-body standing posture is not established by this frame\.?/gi, "")
    .replace(/\bposture labels are intentionally conservative for close-up pelvic views\.?/gi, "")
    .replace(/\bclose-up pelvic\/genital reference view;\s*/gi, "")
    .replace(/\bclose-up pelvic\/genital reference view\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+·\s+$/g, "")
    .trim();
}

function normalizeProfileImageMetadata(image = {}) {
  const combined = [
    image.view_label,
    image.body_position,
    image.coverage,
    image.visibility_notes,
    ...(Array.isArray(image.major_regions_visible) ? image.major_regions_visible : []),
  ].filter(Boolean).join(" ").toLowerCase();
  const hasPelvicDisclaimer = /\bclose-up pelvic\/genital reference view\b|\bwhole-body standing posture is not established\b|\bposture labels are intentionally conservative for close-up pelvic views\b/i.test(
    [image.view_label, image.body_position, image.visibility_notes].filter(Boolean).join(" ")
  );
  const cleaned = {
    ...image,
    view_label: cleanProfileImageMetadataText(image.view_label || ""),
    body_position: cleanProfileImageMetadataText(image.body_position || ""),
    coverage: cleanProfileImageMetadataText(image.coverage || ""),
    visibility_notes: cleanProfileImageMetadataText(image.visibility_notes || ""),
  };
  if (!hasPelvicDisclaimer) return cleaned;
  if (/\b(feet|foot|toes?|ankles?|heels?)\b/.test(combined)) {
    return { ...cleaned, view_label: "Foot and ankle reference view" };
  }
  if (/\b(lower leg|calf|knee|thigh|lower limb)\b/.test(combined)) {
    return { ...cleaned, view_label: "Lower-limb reference view" };
  }
  if (/\b(abdomen|abdominal|flank|umbilicus|bite wound)\b/.test(combined)) {
    return { ...cleaned, view_label: "Abdominal reference view" };
  }
  return cleaned;
}

export function profileImageReviewTopicKey(value = "") {
  const text = String(value || "").toLowerCase();
  if (!text.trim()) return "";
  if (/\bcentral adip|abdominal projection|abdomen projects|abdominal contour|pannus|lower abdominal fullness|infraumbilical\b/.test(text)) return "central-adiposity";
  if (/\bshoulders?\b.*\b(level|symmetric|symmetry|asymmetry)|\b(level|symmetric)\b.*\bshoulders?\b/.test(text)) return "shoulder-symmetry";
  if (/\b(limb proportionality|limbs? appear proportionate|gross limb asymmetry|limb symmetry|bilaterally symmetric in length|lower limbs? appear symmetric)\b/.test(text)) return "limb-proportionality";
  if (/\b(follicular|erythematous papules?|papular|keratosis|inguinal|inner thigh|gluteal|perianal)\b/.test(text) && /\b(papules?|spots?|follicular|erythematous)\b/.test(text)) return "follicular-papules";
  if (/\b(flaccid|foreskin|glans|penile|penis|scrotum|testes|testicular)\b/.test(text) && /\b(stable|baseline|resting|normal|symmetric|foreskin|flaccid)\b/.test(text)) return "stable-genital-baseline";
  if (/\b(raphe|perineal body|scrotal raphe|perineal raphe|midline)\b/.test(text)) return "perineal-scrotal-midline";
  if (/\b(anal verge|anal opening|perianal)\b/.test(text) && /\b(hemorrhoid|fissure|skin tag|lesion|symmetric|intact|normal)\b/.test(text)) return "anal-verge";
  if (/\bmeat(?:al|us)\b/.test(text) && /\b(bright|highlight|fluid|droplet|secretion)\b/.test(text)) return "meatal-highlight";
  if (/\b(anterior pelvic tilt|lumbar lordosis|lordotic|sagittal posture)\b/.test(text)) return "sagittal-posture";
  return text.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180);
}

function evidenceRank(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\b(current batch|directly observed|direct visual|visible in (?:the )?(?:current|uploaded|attached|fresh)|this run)\b/.test(text)) return 3;
  if (/\b(prior saved|saved evidence|prior baseline|stable from prior baseline|carried forward)\b/.test(text)) return 2;
  if (/\b(profile|context only|historical context)\b/.test(text)) return 1;
  return 0;
}

function findingQualityScore(value = "") {
  const text = String(value || "");
  let score = Math.min(4, Math.floor(text.length / 45));
  if (/\bwithout obvious\b|\bno visible\b|\bbroadly\b|\bdistribution\b|\bstatic image cannot confirm\b/i.test(text)) score += 2;
  if (/\bpossible\b|\blikely\b|\bdirectly observed\b|\bstable from prior baseline\b/i.test(text)) score += 1;
  if (text.length < 28) score -= 2;
  return score;
}

function isLowValueMissingCoverage(value = "", coverage = {}) {
  const text = String(value || "").toLowerCase();
  if (!/\b(?:missing|needed|need|request|not visible|not included|not available|coverage gap|optional)\b/.test(text)) return false;
  if (coverage.hasWholeBody && /\b(whole-body|whole body|full-body|full body|head-to-toe|standing anterior|standing posterior|standing lateral|anterior whole-body|posterior whole-body|lateral whole-body)\b/.test(text)) return true;
  if (coverage.hasFeet && /\b(feet|foot|toe|toes)\b/.test(text) && !/\b(dedicated|close-up|gait)\b/.test(text)) return true;
  if (coverage.hasHands && /\b(hands?|upper limbs?)\b/.test(text) && !/\b(dedicated|close-up)\b/.test(text)) return true;
  if (coverage.hasPelvic && /\b(pelvic|genital|perineal|scrotal|penile)\b/.test(text) && !/\b(state|erect|ventral|dedicated|specific)\b/.test(text)) return true;
  return false;
}

export function inferProfileImageCoverage(result = {}) {
  const chunks = [];
  const add = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === "object") Object.values(value).forEach(add);
    else chunks.push(String(value));
  };
  add(result.annotated_images);
  add(result.image_region_findings);
  add(result.coverage_map);
  add(result.summary_card?.coverage);
  const text = chunks.join(" ").toLowerCase();
  return {
    hasWholeBody: /\b(whole-body|whole body|full-body|full body|head-to-toe|head to toe|standing|anterior view|posterior view|lateral view|supine full)\b/.test(text),
    hasFeet: /\b(feet|foot|toe|toes|heel|ankle)\b/.test(text),
    hasHands: /\b(hands?|forearms?|upper limbs?)\b/.test(text),
    hasPelvic: /\b(pelvic|genital|penis|penile|scrot|testes|perineal|perianal|anal verge)\b/.test(text),
  };
}

export function dedupeProfileImageReviewItems(items = [], {
  limit = 14,
  coverage = {},
  suppressMissingCovered = true,
} = {}) {
  const byTopic = new Map();
  const order = [];
  for (const item of items) {
    const text = cleanProfileImageReviewText(item);
    if (!text) continue;
    if (suppressMissingCovered && isLowValueMissingCoverage(text, coverage)) continue;
    const key = profileImageReviewTopicKey(text);
    if (!key) continue;
    const existing = byTopic.get(key);
    if (!existing) {
      byTopic.set(key, text);
      order.push(key);
      continue;
    }
    const existingRank = evidenceRank(existing);
    const nextRank = evidenceRank(text);
    if (
      nextRank > existingRank ||
      (nextRank === existingRank && findingQualityScore(text) > findingQualityScore(existing)) ||
      (nextRank === existingRank && findingQualityScore(text) === findingQualityScore(existing) && text.length < existing.length && text.length > 40)
    ) {
      byTopic.set(key, text);
    }
  }
  return order.map((key) => byTopic.get(key)).filter(Boolean).slice(0, limit);
}

export function cleanupProfileImageReviewResult(result = {}, { sections = [] } = {}) {
  if (!result || typeof result !== "object") return result;
  const cleaned = { ...result };
  const coverage = inferProfileImageCoverage(cleaned);
  cleaned.overview = cleanProfileImageReviewText(cleaned.overview || "");

  if (cleaned.summary_card && typeof cleaned.summary_card === "object") {
    cleaned.summary_card = {
      ...cleaned.summary_card,
      baseline_quality: cleanProfileImageReviewText(cleaned.summary_card.baseline_quality || ""),
      coverage: cleanProfileImageReviewText(cleaned.summary_card.coverage || ""),
      primary_reference_value: dedupeProfileImageReviewItems(cleaned.summary_card.primary_reference_value || [], { limit: 8, coverage }),
      key_direct_findings: dedupeProfileImageReviewItems(cleaned.summary_card.key_direct_findings || [], { limit: 12, coverage }),
      key_limitations: dedupeProfileImageReviewItems(cleaned.summary_card.key_limitations || [], { limit: 6, coverage }),
      evidence_note: cleanProfileImageReviewText(cleaned.summary_card.evidence_note || ""),
    };
  }

  for (const section of sections) {
    if (!Array.isArray(cleaned[section.key])) continue;
    const sectionLimit = /coverage_map|significant_findings/i.test(section.key) ? 10 : /missing|optional|gap|limit/i.test(section.key) ? 6 : 16;
    cleaned[section.key] = dedupeProfileImageReviewItems(cleaned[section.key], {
      limit: sectionLimit,
      coverage,
      suppressMissingCovered: true,
    });
  }

  cleaned.annotated_images = Array.isArray(cleaned.annotated_images)
    ? cleaned.annotated_images.map((image) => normalizeProfileImageMetadata(image))
    : [];
  cleaned.image_region_findings = Array.isArray(cleaned.image_region_findings)
    ? dedupeImageRegionFindings(cleaned.image_region_findings)
    : [];
  return reduceProfileFindingRepetition(cleaned, { sections });
}

export function dedupeImageRegionFindings(findings = []) {
  const byTopic = new Map();
  const order = [];
  for (const finding of findings) {
    const text = cleanProfileImageReviewText(finding?.finding || "");
    const label = cleanProfileImageReviewText(finding?.label || finding?.region || "");
    if (!text && !label) continue;
    const key = `${finding?.section_key || ""}:${profileImageReviewTopicKey(`${label}. ${text}`)}`;
    if (!byTopic.has(key)) order.push(key);
    const existing = byTopic.get(key);
    const next = { ...finding, label, finding: text, region: cleanProfileImageReviewText(finding?.region || "") };
    if (!existing || evidenceRank(text) > evidenceRank(existing.finding || "") || text.length < String(existing.finding || "").length) {
      byTopic.set(key, next);
    }
  }
  return order.map((key) => byTopic.get(key)).filter(Boolean);
}
