function itemText(item) {
  if (typeof item === "string") return item;
  return `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.trim();
}

function lowerItemText(item) {
  return itemText(item).toLowerCase();
}

export function hasBlueObjectFoleyMislabel(item) {
  const text = lowerItemText(item);
  return /(blue[-\s]?(?:tipped|capped)?\s+(?:object|item|bottle|cap)|blue\s+(?:object|item|bottle|cap))/.test(text)
    && /(foley|catheter|drainage tubing|catheter port|catheter already|already in place|right field edge|field edge|tray)/.test(text)
    && !/(catheter tip (?:is )?(?:visible|at|entering)|tip (?:is )?(?:visible|at|entering) (?:the )?meatus|shaft (?:is )?(?:visible|at|entering)|through (?:the )?meatus|connected tubing)/.test(text);
}

export function hasUnsupportedFoleySecurementClaim(item) {
  const text = lowerItemText(item);
  return /(statlock|securement|securement device|securement work|securement finalization|anchor|anchoring|anchored)/.test(text)
    && /(foley|catheter|tubing|yellow|shaft|glans|penis|drape|field|gloved hand|hand)/.test(text);
}

export function hasUnsupportedAlreadyPlacedClaim(item) {
  const text = lowerItemText(item);
  return /(already\s+(?:in\s+place|placed|inserted)|post[-\s]?placement|continued\s+dwell|dwell\s+interval|placement\s+(?:is\s+)?complete|completed\s+placement|catheter\s+(?:is\s+)?seated|seated\s+catheter|catheter\s+has\s+been\s+placed)/.test(text)
    && /(now\s+(?:clearly\s+)?visible|newly\s+visible|first\s+visible|becomes?\s+visible|change\s+from\s+prior|exits?\s+(?:the\s+)?glans|exiting\s+(?:the\s+)?glans|at\s+(?:the\s+)?glans|glans\/meatus|meatus|meatal|catheter\s+junction|yellow\s+tubing|foley\s+tubing|catheter\s+tubing|tubing\s+(?:visible|exiting|routing|handling)|gloved\s+hand|field\s+handling)/.test(text)
    && !/(manual(?:ly)?\s+(?:confirmed|logged)|explicitly\s+logged|urine\s+(?:return|visible|collection|collected)|balloon\s+(?:inflation|inflated)|bag\s+collection|drape\s+removal\s+with\s+urine)/.test(text);
}

export function hasUnsupportedFoleyStageForecast(item) {
  const text = lowerItemText(item);
  return /(meatal engagement|catheter engagement|foley engagement|insertion|advancement|advanced|entering|passes? (?:the )?meatus|catheter positioning|foley positioning)/.test(text)
    && /(imminent|about to|appears to|appears imminent|suggesting|consistent with|prepar(?:e|ing)|nearby|toward|lowering toward|positioning)/.test(text)
    && !/(visible advancement|visibly advancing|visible tip|tip visibly|tip at|entering the meatus is visible|through the meatus|less (?:of the )?(?:foley|catheter) (?:is )?visible|external (?:foley|catheter|shaft) (?:length )?(?:shortens|decreases|reduces)|progressive(?:ly)? (?:shortening|less visible)|remaining visible length)/.test(text);
}

export function hasVisibleFoleyAdvancementCue(item) {
  const text = lowerItemText(item);
  if (!/(foley|catheter|shaft|tubing)/.test(text)) return false;
  return /(visible advancement|visibly advancing|advancement is visible|active advancement|less (?:of the )?(?:external )?(?:catheter shaft|foley shaft|foley|catheter|shaft) (?:is |remains |becomes )?visible|(?:catheter shaft|foley shaft|foley|catheter|shaft) (?:becomes|is becoming|gets) less visible|external (?:catheter shaft|foley shaft|foley|catheter|shaft) (?:length )?(?:shortens|decreases|reduces|remains visible)|progressive(?:ly)? (?:shortening|less visible)|remaining visible length (?:shortens|decreases|reduces)|more (?:of the )?(?:foley|catheter|shaft) disappears)/.test(text)
    && /(meatus|meatal|glans|penis|urethra|insertion|advancement|continuous|aligned|same axis|tracks with)/.test(text);
}

export function hasUnsupportedMeatusContactClaim(item) {
  const text = lowerItemText(item);
  if (!/(foley|catheter|18\s*fr|tool|tip|shaft|tubing)/.test(text)) return false;
  if (!/(meatus|meatal|glans\/meatus)/.test(text)) return false;
  if (/(not confirmed|cannot confirm|uncertain|possible|no visible|not visible|blocked|obscured)/.test(text)) return false;
  if (hasVisibleFoleyAdvancementCue(item)) return false;
  return /(toward\s+and\s+at|at\s+(?:the\s+)?meatus|contact(?:ing)?\s+(?:the\s+)?meatus|touch(?:ing)?\s+(?:the\s+)?meatus|aligned\s+(?:with|at)\s+(?:the\s+)?meatus|enter(?:ing|s)?\s+(?:the\s+)?meatus|advanc(?:e|ed|ing|ement)|through\s+(?:the\s+)?meatus|tip\s+(?:is\s+)?(?:visible\s+)?(?:at|touching|contacting|entering))/i.test(text);
}

export function hasUnsupportedSleeveUseClaim(item) {
  const text = lowerItemText(item);
  if (!/\bsleeve\b/.test(text)) return false;
  if (/(not confirmed|cannot confirm|uncertain|possible|no visible|not visible|before placement|not yet placed|not placed)/.test(text)) return false;
  return /(sleeve[-\s]?based stimulation|stimulation (?:continues|underway|resumes) (?:with|in|through)?\s*(?:the\s+)?sleeve|gripping and stroking (?:the\s+)?sleeve|stroking (?:inside|with|through)?\s*(?:the\s+)?sleeve|sleeve (?:continues|underway|placed|on shaft|over shaft|encases|covers))/i.test(text)
    && !/(sleeve (?:is\s+)?visibly (?:placed|on|over|around)|visibly (?:placed|on|over).{0,40}sleeve|shaft (?:is\s+)?inside (?:the\s+)?sleeve|glans.{0,40}inside (?:the\s+)?sleeve)/i.test(text);
}

export function foleyEvidenceStageForText(text) {
  const value = String(text || "").toLowerCase();
  if (hasBlueObjectFoleyMislabel({ text: value })) return { stage: "tray object", blocked: true };
  if (hasUnsupportedAlreadyPlacedClaim({ text: value })) return { stage: "placement not confirmed", blocked: true };
  if (hasUnsupportedMeatusContactClaim({ text: value })) return { stage: "meatus contact not confirmed", blocked: true };
  if (hasUnsupportedFoleyStageForecast({ text: value })) return { stage: "field preparation", blocked: true };
  if (hasUnsupportedFoleySecurementClaim({ text: value })) return { stage: "tubing/field handling", blocked: true };
  if (/\b(foley|catheter|tubing)\b/.test(value)) return { stage: "Foley evidence", blocked: false };
  return null;
}

export function sleeveEvidenceStageForText(text) {
  const value = String(text || "").toLowerCase();
  if (hasUnsupportedSleeveUseClaim({ text: value })) return { stage: "sleeve use not confirmed", blocked: true };
  if (/\bsleeve\b/.test(value)) return { stage: "sleeve evidence", blocked: false };
  return null;
}

export function deviceEvidenceStageForText(text) {
  return foleyEvidenceStageForText(text) || sleeveEvidenceStageForText(text);
}

export function sanitizeSecondPersonProcedureLanguage(text) {
  return String(text || "")
    .replace(/\bsubject's\b/gi, "your")
    .replace(/\bthe subject's\b/gi, "your")
    .replace(/\bsubject is visible\b/gi, "you are visible")
    .replace(/\bsubject visible\b/gi, "you are visible")
    .replace(/\bsubject is\b/gi, "you are")
    .replace(/\bsubject remains\b/gi, "you remain")
    .replace(/\bsubject\b/gi, "you")
    .replace(/\boperator's hand\b/gi, "gloved hand")
    .replace(/\boperator hand\b/gi, "gloved hand")
    .replace(/\boperator hands\b/gi, "gloved hands")
    .replace(/\bthe operator\b/gi, "the gloved person")
    .replace(/\boperator\b/gi, "gloved person")
    .replace(/\b(?:a|the)\s+gloved\s+hand\b/gi, "your hand")
    .replace(/\b(?:a|the)\s+gloved\s+hands\b/gi, "your hands")
    .replace(/\bone\s+gloved\s+hand\b/gi, "one hand")
    .replace(/\bthe\s+other\s+gloved\s+hand\b/gi, "the other hand")
    .replace(/\bgloved\s+person\b/gi, "your hand")
    .replace(/\bvisible\s+gloved\s+hand\b/gi, "your hand")
    .replace(/\byou visible\b/gi, "you are visible")
    .replace(/\byou seated\b/gi, "you are seated")
    .replace(/\byou positioned\b/gi, "you are positioned");
}

export function sanitizeFoleyProcedureText(text) {
  let next = sanitizeSecondPersonProcedureLanguage(text);
  const flags = [];
  if (hasBlueObjectFoleyMislabel({ text: next })) {
    flags.push("Blue tray/lubricant object blocked as Foley evidence");
    next = next
      .replace(/\bblue[-\s]?tipped\s+object\s+consistent\s+with\s+(?:the\s+)?(?:Dover\s+18\s*Fr\s+)?Foley\s+drainage\s+tubing\s+or\s+catheter\s+port\b/gi, "blue item on the procedure tray, most consistent with lubricant/prep material")
      .replace(/\bblue[-\s]?tipped\s+(?:Foley|catheter|drainage tubing|catheter port)\b/gi, "blue tray item")
      .replace(/\bblue\s+(?:Foley|catheter|drainage tubing|catheter port)\b/gi, "blue tray item")
      .replace(/\b(?:Dover\s+18\s*Fr\s+)?Foley\s+drainage\s+tubing\s+or\s+catheter\s+port\s+(?:becomes|is|remains)\s+visible\b/gi, "procedure-tray item remains visible")
      .replace(/\bFoley\s+appears\s+already\s+in\s+place\b/gi, "Foley placement is not confirmed from this tray-side object")
      .replace(/\bcatheter\s+already\s+(?:in\s+place|present)\b/gi, "catheter placement not confirmed from this tray-side object");
  }
  if (hasUnsupportedAlreadyPlacedClaim({ text: next })) {
    flags.push("Already-in-place claim blocked");
    next = next
      .replace(/\b(?:the\s+)?Foley\s+catheter\s+(?:is\s+)?already\s+in\s+place\s+at\s+(?:the\s+)?glans\/meatus\b/gi, "Foley/catheter material may be near the glans/meatus; placement is not confirmed from this window alone")
      .replace(/\b(?:the\s+)?catheter\s+(?:is\s+)?already\s+in\s+place\s+at\s+(?:the\s+)?glans\/meatus\b/gi, "catheter material may be near the glans/meatus; placement is not confirmed from this window alone")
      .replace(/\b(?:the\s+)?Foley\s+catheter\s+(?:is\s+)?already\s+in\s+place\s+at\s+(?:the\s+)?meatus\b/gi, "Foley/catheter material may be near the meatus; placement is not confirmed from this window alone")
      .replace(/\b(?:the\s+)?catheter\s+(?:is\s+)?already\s+in\s+place\s+at\s+(?:the\s+)?meatus\b/gi, "catheter material may be near the meatus; placement is not confirmed from this window alone")
      .replace(/\b(?:yellow\s+)?(?:Foley\s+)?tubing\s+exits?\s+(?:the\s+)?glans\b/gi, "Foley/tubing may be visible near the glans/meatus region")
      .replace(/\b(?:yellow\s+)?(?:Foley\s+)?tubing\s+exits?\s+(?:the\s+)?meatus\b/gi, "Foley/tubing may be visible near the meatus")
      .replace(/\b(?:the\s+)?catheter\s+(?:is\s+)?seated\b/gi, "catheter seating is not confirmed from this window alone")
      .replace(/\bseated\s+catheter\b/gi, "possible catheter/Foley-at-meatus state")
      .replace(/\b(?:the\s+)?catheter\s+has\s+been\s+placed\b/gi, "catheter placement is not confirmed from this window alone")
      .replace(/\b(?:the\s+)?Foley\s+catheter\s+(?:is\s+)?already\s+in\s+place\b/gi, "Foley/catheter placement is not confirmed from this window alone")
      .replace(/\b(?:the\s+)?catheter\s+(?:is\s+)?already\s+in\s+place\b/gi, "catheter placement is not confirmed from this window alone")
      .replace(/\bconfirming\s+(?:the\s+)?catheter\s+(?:is\s+)?already\s+in\s+place\b/gi, "showing possible catheter/Foley material without proving completed placement")
      .replace(/\bcontinued\s+post[-\s]?placement\s+dwell\s+state\b/gi, "possible catheter/Foley-at-meatus state")
      .replace(/\bpost[-\s]?placement\s+dwell\s+state\b/gi, "possible catheter/Foley-at-meatus state")
      .replace(/\bcontinued\s+dwell\s+interval\b/gi, "possible catheter/Foley-at-meatus interval")
      .replace(/\bdwell\s+interval\b/gi, "possible catheter/Foley-at-meatus interval")
      .replace(/\balready\s+(?:in\s+place|placed|inserted)\b/gi, "not confirmed as placed");
  }
  if (hasUnsupportedMeatusContactClaim({ text: next })) {
    flags.push("Meatus contact/advancement claim blocked");
    const beforeMeatusCleanup = next;
    next = next
      .replace(/\b(?:the\s+)?(?:lubricated\s+)?(?:(?:Dover\s+)?18\s*Fr\s+)?Foley\s+catheter\s+tip\s+toward\s+and\s+at\s+(?:the\s+)?meatus\b/gi, "possible field/tool handling near the genital field; catheter tip at the meatus is not confirmed")
      .replace(/\b(?:the\s+)?(?:lubricated\s+)?(?:(?:Dover\s+)?18\s*Fr\s+)?Foley\s+catheter\s+tip\s+(?:is\s+)?(?:at|touching|contacting|aligned at|aligned with|entering)\s+(?:the\s+)?meatus\b/gi, "catheter tip at the meatus is not confirmed from this window")
      .replace(/\b(?:catheter|foley|tool)\s+tip\s+(?:is\s+)?(?:at|touching|contacting|aligned at|aligned with|entering)\s+(?:the\s+)?meatus\b/gi, "catheter/tool tip at the meatus is not confirmed from this window");
    if (next === beforeMeatusCleanup) {
      next = next
        .replace(/\b(?:at|touching|contacting|aligned at|aligned with)\s+(?:the\s+)?meatus\b/gi, "near the genital field, with meatal contact not confirmed")
        .replace(/\b(?:advancing|advanced|advancement)\s+(?:through|at|into)?\s*(?:the\s+)?meatus\b/gi, "advancement through the meatus is not confirmed")
        .replace(/\b(?:entering|enters)\s+(?:the\s+)?meatus\b/gi, "entry at the meatus is not confirmed")
        .replace(/\bpasses?\s+(?:the\s+)?meatus\b/gi, "passage through the meatus is not confirmed");
    } else {
      next = next
        .replace(/\b(?:advancing|advanced|advancement)\s+(?:through|at|into)?\s*(?:the\s+)?meatus\b/gi, "advancement through the meatus is not confirmed")
        .replace(/\b(?:entering|enters)\s+(?:the\s+)?meatus\b/gi, "entry at the meatus is not confirmed")
        .replace(/\bpasses?\s+(?:the\s+)?meatus\b/gi, "passage through the meatus is not confirmed");
    }
    next = next
      .replace(/\bnot confirmed from this window is not confirmed\b/gi, "not confirmed from this window")
      .replace(/\bcatheter\/tool tip at the meatus is not confirmed\b/gi, "catheter tip at the meatus is not confirmed")
      .replace(/\bis not confirmed is not confirmed\b/gi, "is not confirmed");
  }
  if (hasUnsupportedFoleySecurementClaim({ text: next })) {
    flags.push("Securement claim blocked");
    next = next
      .replace(/\bStatLock\b/gi, "Foley/tubing")
      .replace(/\b(?:adhesive\s+)?securement\s+(?:device\s+)?(?:application|finalization|work|step|process|anchor|anchoring)?\b/gi, "tubing/field handling")
      .replace(/\bsecurement\b/gi, "tubing/field handling")
      .replace(/\banchoring\b/gi, "routing")
      .replace(/\banchored\b/gi, "routed")
      .replace(/\banchor\b/gi, "route")
      .replace(/\bfinal\s+routing\b/gi, "routing")
      .replace(/\bfinalized\b/gi, "handled")
      .replace(/\bfinalization\b/gi, "handling")
      .replace(/\bFoley\/tubing\s+tubing\b/gi, "Foley tubing")
      .replace(/\btubing\/field handling\s+tubing\/field handling\b/gi, "tubing/field handling");
  }
  if (hasUnsupportedFoleyStageForecast({ text: next })) {
    flags.push("Forecasted Foley stage blocked");
    next = next
      .replace(/\b(?:meatal|catheter|foley)\s+engagement\s+(?:appears\s+)?imminent\b/gi, "field preparation continues")
      .replace(/\b(?:meatal|catheter|foley)\s+engagement\b/gi, "field preparation")
      .replace(/\bcatheter\s+positioning\b/gi, "field/tool positioning")
      .replace(/\bfoley\s+positioning\b/gi, "field/tool positioning")
      .replace(/\bvisible\s+advancement\s+appears\s+imminent\b/gi, "field preparation continues")
      .replace(/\b(?:insertion|advancement)\s+(?:appears\s+)?imminent\b/gi, "field preparation continues")
      .replace(/\b(?:insertion|advancement)\b/gi, "field preparation")
      .replace(/\bpasses?\s+(?:the\s+)?meatus\b/gi, "near the field")
      .replace(/\bentering\b/gi, "near")
      .replace(/\bappears\s+imminent\b/gi, "is not yet visible")
      .replace(/\bimminent\b/gi, "not yet visible");
  }
  return { text: next.replace(/\bbegins advancing possible field\/tool handling\b/gi, "shows possible field/tool handling").replace(/\s+/g, " ").trim(), flags };
}

export function sanitizeSleeveSessionText(text) {
  let next = String(text || "");
  const flags = [];
  if (hasUnsupportedSleeveUseClaim({ text: next })) {
    flags.push("Sleeve active-use claim blocked");
    const beforeSleeveCleanup = next;
    next = next
      .replace(/\bsleeve[-\s]?based stimulation\s+(?:continues|is\s+)?(?:underway|continues|resumes)?\b/gi, "possible sleeve/hand preparation is visible; sleeve-based stimulation is not confirmed")
      .replace(/\bgripping and stroking (?:the\s+)?sleeve\b/gi, "hand contact/motion is visible; sleeve placement is not confirmed")
      .replace(/\bsleeve\s+(?:continues|underway|placed|on shaft|over shaft|encases|covers)\b/gi, "sleeve use is not confirmed");
    if (next === beforeSleeveCleanup) {
      next = next.replace(/\bstroking (?:inside|with|through)?\s*(?:the\s+)?sleeve\b/gi, "hand motion is visible; sleeve use is not confirmed");
    }
  }
  return {
    text: next
      .replace(/\bhand hand contact\b/gi, "hand contact")
      .replace(/\s+-\s+possible sleeve\/hand preparation is visible; sleeve-based stimulation is not confirmed\b/gi, "")
      .replace(/\s+/g, " ")
      .trim(),
    flags,
  };
}
