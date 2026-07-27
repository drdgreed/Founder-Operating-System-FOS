// ===========================================================================
// Guarantee classifier eval corpus (issue #106, Option C slice 1).
//
// DAVID'S CONFIRMED corpus, encoded as labeled entries. This is the CONTRACT
// the semantic classifier is measured against: every `block` row is a real
// EMPLOYMENT-OUTCOME guarantee that must never reach a student unchallenged;
// every `allow` row is legitimate READINESS/PREPARATION copy the program is
// entitled to make. The load-bearing rows are the BOUNDARY pairs where the same
// word flips meaning ("interview" practice vs. acquired; "job-ready" vs. "get
// you a job"). RECALL IS PARAMOUNT: an `allow` on a `block` row is a hard fail.
// ===========================================================================

export interface GuaranteeCorpusEntry {
  text: string;
  expected: "allow" | "block";
  note?: string;
}

export const GUARANTEE_CORPUS: GuaranteeCorpusEntry[] = [
  // --- CONFIRMED ALLOW (readiness / preparation) --------------------------
  {
    text: "you'll graduate job-ready",
    expected: "allow",
    note: "confirmed; BOUNDARY: capability, not an acquired job",
  },
  { text: "prepared to enter the market", expected: "allow", note: "confirmed readiness" },
  {
    text: "your LinkedIn & resume will be employer-ready",
    expected: "allow",
    note: "confirmed; the program controls the artifact",
  },
  {
    text: "a portfolio that proves your expertise",
    expected: "allow",
    note: "confirmed; evidences capability",
  },
  {
    text: "you'll be well-practiced at interviewing",
    expected: "allow",
    note: "confirmed; BOUNDARY: interview as PRACTICE",
  },
  {
    text: "interview-ready by the end of the module",
    expected: "allow",
    note: "confirmed; readiness, not an acquired interview",
  },
  {
    text: "we make sure you're prepared for interviews",
    expected: "allow",
    note: "confirmed; preparation",
  },

  // --- CONFIRMED BLOCK (employment outcome the employer controls) ---------
  { text: "we guarantee you a job", expected: "block", note: "confirmed; acquired job" },
  { text: "guaranteed employment on completion", expected: "block", note: "confirmed" },
  {
    text: "we'll get you an interview with hiring partners",
    expected: "block",
    note: "confirmed; BOUNDARY: interview ACQUIRED from an employer",
  },
  {
    text: "guaranteed interviews with employers",
    expected: "block",
    note: "confirmed; employer interviews",
  },
  { text: "a guaranteed $90k salary", expected: "block", note: "confirmed; compensation figure" },
  { text: "we'll get you hired", expected: "block", note: "confirmed; being hired" },
  { text: "guaranteed placement", expected: "block", note: "confirmed; placement" },
  {
    text: "we promise you a role at a partner company",
    expected: "block",
    note: "confirmed; a role at a company",
  },
  { text: "you'll land a job in 90 days", expected: "block", note: "confirmed; acquired job" },

  // --- BOUNDARY rows (labeled exactly per the contract) -------------------
  // The ALLOW halves of the two boundary pairs live verbatim in CONFIRMED ALLOW
  // above ("you'll be well-practiced at interviewing", "you'll graduate
  // job-ready") — carried there with BOUNDARY notes — so they are NOT repeated
  // here (dedupe, Fix 6). These are the BLOCK halves.
  {
    text: "we'll get you an interview",
    expected: "block",
    note: "BOUNDARY pair A: acquired interview → block (allow half: 'well-practiced at interviewing')",
  },
  {
    text: "we'll get you a job",
    expected: "block",
    note: "BOUNDARY pair B: acquired job → block (allow half: 'graduate job-ready')",
  },

  // --- ADDED ALLOW (mine; strengthen precision on readiness copy) ---------
  {
    text: "graduate market-ready with a portfolio that shows your skills",
    expected: "allow",
    note: "added; readiness + evidence",
  },
  {
    text: "you'll be prepared to ace technical interviews",
    expected: "allow",
    note: "added; BOUNDARY: 'interviews' as skill preparation, not acquisition",
  },
  {
    text: "our mock interviews leave you well-practiced and confident",
    expected: "allow",
    note: "added; practice interviews the program runs",
  },
  {
    text: "build an employer-ready resume that showcases your expertise",
    expected: "allow",
    note: "added; program-controlled artifact",
  },
  {
    text: "by graduation your skills will be market-ready",
    expected: "allow",
    note: "added; capability",
  },

  // --- ADDED BLOCK (mine; strengthen recall on outcome guarantees) --------
  {
    text: "we guarantee you'll be hired within six months",
    expected: "block",
    note: "added; being hired",
  },
  {
    text: "guaranteed job placement with our partner employers",
    expected: "block",
    note: "added; placement",
  },
  {
    text: "we'll secure you an interview at a top tech company",
    expected: "block",
    note: "added; acquired interview",
  },
  {
    text: "you're guaranteed a six-figure salary after the program",
    expected: "block",
    note: "added; compensation figure",
  },
  {
    text: "we promise to land you a role at a Fortune 500 company",
    expected: "block",
    note: "added; a role at a company",
  },

  // =========================================================================
  // INTERNAL ANALYTICAL TEXT (P1.10i)
  //
  // Why this section exists. Until P1.10f the classifier's prompt scoped it to
  // "student-facing marketing or coaching copy". The second live run fed it
  // enrollment-brief output — internal analytical notes — and it blocked 8 of 8
  // while explicitly saying nothing was prohibited: out of genre, so
  // low-confidence, so fail-closed. P1.10f widened the scope. But the corpus
  // that GATES that change contained no analytical text at all, so the recall
  // eval could confirm no harm and still say nothing about whether the fix
  // works. These rows close that gap.
  //
  // TWO STRUCTURAL DIFFERENCES from the marketing rows above, and both matter:
  //
  //  1. THIRD PERSON. Analytical text is written ABOUT an applicant ("she is
  //     certain to receive an offer"), not TO a student ("you'll land a job").
  //     Every tier-1 floor pattern requires a literal "you", so the floor is
  //     STRUCTURALLY BLIND to a guarantee phrased this way. Tier 2 is not the
  //     primary defense here — it is the ONLY defense. The `block` rows below
  //     are therefore all floor-escaping by construction, like SET 2.
  //
  //  2. NO PROMOTIONAL INTENT. These read as record-keeping, which is exactly
  //     what made the classifier hedge. The `allow` rows are the false
  //     positives P1.10f was written to eliminate.
  //
  // A guarantee here is not harmless: the brief is founder-facing, and P-004's
  // whole history is a guarantee reaching a rendered artifact through a field
  // nobody was scanning. A founder can paste a brief into an email.
  // =========================================================================

  // --- analytical ALLOW: ordinary brief content, no promise of any kind ----
  {
    text: "Applicant is a working data analyst targeting a senior analytics role within three months.",
    expected: "allow",
    note: "analytical; candidateSummary — descriptive, no promise",
  },
  {
    text: "Observed: currently employed as a Data Analyst at Acme Corp.",
    expected: "allow",
    note: "analytical; observedFact — a sourced statement of fact",
  },
  {
    text: "Readiness: insufficient_information — the application does not state prior experience.",
    expected: "allow",
    note: "analytical; the no-fabrication case, admitting a gap",
  },
  {
    text: "Risk flag: applicant has revoked marketing-contact consent; founder-only review recommended.",
    expected: "allow",
    note: "analytical; riskFlag — the exact shape that blocked in live run 2",
  },
  {
    text: "Unknown: budget authority is not stated anywhere in the application.",
    expected: "allow",
    note: "analytical; unknowns entry — terse, which previously read as 'vague'",
  },
  {
    text: "Next action: schedule a discovery call to clarify timeline and budget.",
    expected: "allow",
    note: "analytical; nextAction — an internal instruction to the founder",
  },
  {
    text: "Inference (medium confidence): likely ready for an accelerated pathway given her current role.",
    expected: "allow",
    note: "analytical; labeled inference — 'ready' is readiness, and 'role' is descriptive",
  },
  {
    text: "Discovery question: what is your budget range for this programme?",
    expected: "allow",
    note: "analytical; a question, not a claim",
  },

  // --- analytical BLOCK: a real outcome guarantee hiding in internal text ---
  // All floor-escaping (third person / no "you"), so tier 2 alone must catch
  // them. If any of these is ALLOWED, the widened scope has cost real recall.
  {
    text: "Next action: confirm to the applicant that we will place her in a senior analyst role within 90 days of graduation.",
    expected: "block",
    note: "analytical-block; floor-escaping (3rd person) placement promise in a nextAction",
  },
  {
    text: "Given her portfolio, she is certain to receive an offer from one of our hiring partners.",
    expected: "block",
    note: "analytical-block; floor-escaping outcome certainty in an inference",
  },
  {
    text: "Strong candidate; we can promise him a data engineering job on completion.",
    expected: "block",
    note: "analytical-block; 'promise him' escapes the floor's 'promise you' pattern",
  },
  {
    text: "Recommend telling this applicant that every graduate of the accelerated track walks into employment.",
    expected: "block",
    note: "analytical-block; a guarantee the brief instructs the founder to REPEAT outward",
  },
];
